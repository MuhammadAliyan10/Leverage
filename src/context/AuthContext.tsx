import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { localDb, DbUser } from '../db/local/client';
import { decideRestoredSession } from '../security/sessionPolicy';

const SESSION_KEY = 'houselog_user_id';
const SIGNED_OUT_KEY = 'houselog_signed_out';
type SessionUser = Omit<DbUser, 'passwordHash'>;

export type AuthSession =
  | { status: 'restoring' }
  | { status: 'signedOut'; notice?: string }
  | { status: 'locked'; user: SessionUser; notice?: string }
  | { status: 'signedIn'; user: SessionUser; notice?: string };

interface AuthContextValue {
  session: AuthSession;
  status: AuthSession['status'];
  user: SessionUser | null;
  isLoading: boolean;
  restoreError: string | null;
  sessionNotice: string | null;
  signIn: (email: string, password: string, rememberMe: boolean) => Promise<{ success: boolean; error?: string; passwordUpgradePending?: boolean }>;
  signUp: (fullName: string, email: string, password: string, rememberMe: boolean) => Promise<{ success: boolean; error?: string; notice?: string }>;
  signOut: () => Promise<void>;
  lock: () => void;
  unlockWithPassword: (password: string) => Promise<{ success: boolean; error?: string }>;
  unlockAfterBiometric: () => boolean;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  updateProfileName: (fullName: string) => Promise<void>;
  listProfiles: () => Promise<SessionUser[]>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function readSessionId(): Promise<{ userId: string | null; signedOutMarker: boolean }> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return { userId: null, signedOutMarker: false };
    const signedOutMarker = window.localStorage.getItem(SIGNED_OUT_KEY) === '1';
    return { userId: signedOutMarker ? null : window.localStorage.getItem(SESSION_KEY) ?? window.sessionStorage.getItem(SESSION_KEY), signedOutMarker };
  }
  const signedOutMarker = await SecureStore.getItemAsync(SIGNED_OUT_KEY) === '1';
  return { userId: signedOutMarker ? null : await SecureStore.getItemAsync(SESSION_KEY), signedOutMarker };
}

async function persistSession(userId: string, rememberMe: boolean): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') throw new Error('Browser storage is unavailable.');
    if (rememberMe) {
      window.localStorage.setItem(SESSION_KEY, userId);
      window.sessionStorage.removeItem(SESSION_KEY);
      window.localStorage.removeItem(SIGNED_OUT_KEY);
    } else {
      window.localStorage.setItem(SIGNED_OUT_KEY, '1');
      window.localStorage.removeItem(SESSION_KEY);
      window.sessionStorage.removeItem(SESSION_KEY);
      window.localStorage.removeItem(SIGNED_OUT_KEY);
    }
    return;
  }
  if (rememberMe) {
    await SecureStore.setItemAsync(SESSION_KEY, userId);
    await SecureStore.deleteItemAsync(SIGNED_OUT_KEY);
  } else {
    await SecureStore.setItemAsync(SIGNED_OUT_KEY, '1');
    await SecureStore.deleteItemAsync(SESSION_KEY);
    await SecureStore.deleteItemAsync(SIGNED_OUT_KEY);
  }
}

async function persistSignedOut(): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') throw new Error('Browser storage is unavailable.');
    window.localStorage.setItem(SIGNED_OUT_KEY, '1');
    window.localStorage.removeItem(SESSION_KEY);
    window.sessionStorage.removeItem(SESSION_KEY);
    return;
  }
  // Write a tombstone first. If removal of the session key fails, restoration still
  // treats the saved identifier as signed out on the next launch.
  await SecureStore.setItemAsync(SIGNED_OUT_KEY, '1');
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSessionState] = useState<AuthSession>({ status: 'restoring' });
  const sessionRef = useRef<AuthSession>(session);
  const operationRef = useRef(false);
  const sequenceRef = useRef(0);

  const setSession = useCallback((next: AuthSession) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const stored = await readSessionId();
        if (!stored.userId) {
          if (active) setSession({ status: 'signedOut' });
          return;
        }
        const found = await localDb.user.findById(stored.userId);
        if (!active) return;
        const decision = decideRestoredSession({ savedUserId: stored.userId, signedOutMarker: stored.signedOutMarker, profileExists: found !== null });
        if (decision === 'signedOut' || !found) {
          if (Platform.OS === 'web') {
            window.localStorage.removeItem(SESSION_KEY);
            window.sessionStorage.removeItem(SESSION_KEY);
          } else {
            await SecureStore.deleteItemAsync(SESSION_KEY).catch(() => undefined);
          }
          setSession({ status: 'signedOut', notice: 'Your saved profile is unavailable. Sign in again.' });
          return;
        }
        // Remember me persists the local session across a browser refresh or app restart.
        // The inactivity lock below still protects a session after an extended absence.
        setSession({ status: 'signedIn', user: found });
      } catch {
        if (active) setSession({ status: 'signedOut', notice: 'Your saved session could not be restored. Sign in again; your records were not changed.' });
      }
    })();
    return () => { active = false; };
  }, [setSession]);

  const signIn = useCallback(async (email: string, password: string, rememberMe: boolean) => {
    if (operationRef.current) return { success: false, error: 'Authentication is already in progress. Please wait.' };
    operationRef.current = true;
    const operation = ++sequenceRef.current;
    try {
      const result = await localDb.user.signIn(email, password);
      if (!result.success) return { success: false, error: result.error };
      let notice: string | undefined;
      try { await localDb.user.claimLegacyData(result.user.id); }
      catch { notice = 'Signed in. Older unassigned records could not be linked and were left unchanged.'; }
      try { await persistSession(result.user.id, rememberMe); }
      catch { notice = 'Signed in for this session, but the saved sign-in preference could not be updated. You may need to sign in again after closing HouseLog.'; }
      if (sequenceRef.current !== operation) return { success: false, error: 'Sign-in was cancelled. Please try again.' };
      queryClient.clear();
      setSession({ status: 'signedIn', user: result.user, ...(notice ? { notice } : {}) });
      return { success: true, passwordUpgradePending: result.passwordUpgradePending };
    } catch {
      return { success: false, error: 'Local sign in could not complete. Check device storage and try again.' };
    } finally { if (sequenceRef.current === operation) operationRef.current = false; }
  }, [queryClient, setSession]);

  const signUp = useCallback(async (fullName: string, email: string, password: string, rememberMe: boolean) => {
    if (operationRef.current) return { success: false, error: 'Authentication is already in progress. Please wait.' };
    operationRef.current = true;
    const operation = ++sequenceRef.current;
    try {
      const result = await localDb.user.register(fullName, email, password);
      if (!result.success) return { success: false, error: result.error };
      let notice = 'HouseLog stores this profile and its financial records on this device. There is no cloud account recovery.';
      try { await localDb.user.claimLegacyData(result.user.id); } catch { /* Existing unassigned records remain untouched. */ }
      try { await persistSession(result.user.id, rememberMe); }
      catch { notice += ' This profile was created successfully, but the sign-in preference could not be saved. Continue this session or sign in again later.'; }
      if (sequenceRef.current !== operation) return { success: false, error: 'Sign-up was cancelled. Your profile may already exist; try signing in.' };
      queryClient.clear();
      setSession({ status: 'signedIn', user: result.user, notice });
      return { success: true, notice };
    } catch {
      return { success: false, error: 'Local profile setup could not complete. Check device storage and try again.' };
    } finally { if (sequenceRef.current === operation) operationRef.current = false; }
  }, [queryClient, setSession]);

  const signOut = useCallback(async () => {
    ++sequenceRef.current;
    operationRef.current = false;
    queryClient.clear();
    setSession({ status: 'signedOut' });
    try {
      await persistSignedOut();
    } catch {
      setSession({ status: 'signedOut', notice: 'You are signed out on this screen, but secure storage could not confirm removal of the saved profile. Reopen HouseLog and verify sign-in is required.' });
      // Try clearing the saved identifier even when the tombstone write failed.
      if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(SESSION_KEY).catch(() => undefined);
    }
  }, [queryClient, setSession]);

  const lock = useCallback(() => {
    const current = sessionRef.current;
    if (current.status !== 'signedIn') return;
    queryClient.clear();
    setSession({ status: 'locked', user: current.user, notice: 'Unlock HouseLog to continue.' });
  }, [queryClient, setSession]);

  const unlockAfterBiometric = useCallback((): boolean => {
    const current = sessionRef.current;
    if (current.status !== 'locked') return false;
    queryClient.clear();
    setSession({ status: 'signedIn', user: current.user });
    return true;
  }, [queryClient, setSession]);

  const unlockWithPassword = useCallback(async (password: string) => {
    const locked = sessionRef.current;
    if (locked.status !== 'locked') return { success: false, error: 'The profile is no longer waiting to be unlocked.' };
    const valid = await localDb.user.verifyPassword(locked.user.id, password);
    if (!valid) return { success: false, error: 'Password could not unlock this local profile.' };
    if (sessionRef.current !== locked) return { success: false, error: 'The profile changed. Please try again.' };
    queryClient.clear();
    setSession({ status: 'signedIn', user: locked.user });
    return { success: true };
  }, [queryClient, setSession]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const current = sessionRef.current;
    if (current.status !== 'signedIn') throw new Error('Unlock your profile before changing its password.');
    await localDb.user.changePassword(current.user.id, currentPassword, newPassword);
  }, []);

  const updateProfileName = useCallback(async (fullName: string) => {
    const current = sessionRef.current;
    if (current.status !== 'signedIn') throw new Error('Unlock your profile before editing it.');
    await localDb.user.updateProfileName(current.user.id, fullName);
    const refreshed = await localDb.user.findById(current.user.id);
    if (!refreshed || sessionRef.current.status !== 'signedIn' || sessionRef.current.user.id !== current.user.id) throw new Error('The profile changed before the update completed.');
    setSession({ status: 'signedIn', user: refreshed });
  }, [setSession]);

  const listProfiles = useCallback(() => localDb.user.findMany(), []);

  const value = useMemo<AuthContextValue>(() => {
    const currentUser = session.status === 'signedIn' ? session.user : null;
    const restoreError = session.status === 'signedOut' && session.notice?.includes('could not be restored') ? session.notice : null;
    const sessionNotice = session.status === 'signedIn' || session.status === 'locked' || session.status === 'signedOut' ? session.notice === restoreError ? null : session.notice ?? null : null;
    return {
      session, status: session.status, user: currentUser, isLoading: session.status === 'restoring', restoreError, sessionNotice,
      signIn, signUp, signOut, lock, unlockWithPassword, unlockAfterBiometric, changePassword, updateProfileName, listProfiles,
    };
  }, [session, signIn, signUp, signOut, lock, unlockWithPassword, unlockAfterBiometric, changePassword, updateProfileName, listProfiles]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
