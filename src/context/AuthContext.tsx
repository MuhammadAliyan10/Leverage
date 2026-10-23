import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useColorScheme } from 'nativewind';
import { localDb, DbUser } from '../db/local/client';
import { decideRestoredSession } from '../security/sessionPolicy';
import { appSettings } from '../security/appSettings';
import { DEFAULT_PROFILE_SETTINGS, type AppearancePreference, type ProfileSettings } from '../security/settingsPreferences';
import { cancelProfileReminders } from '../security/localReminders';
import { resolveProfileSwitchTarget } from '../security/profileSwitchPolicy';

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
  appearance: AppearancePreference;
  profileSettings: ProfileSettings;
  pendingProfileEmail: string | null;
  updateAppearance: (appearance: AppearancePreference) => Promise<void>;
  updateProfileSettings: (patch: Partial<ProfileSettings>) => Promise<void>;
  switchLocalProfile: (profileId: string) => Promise<void>;
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
  const { setColorScheme } = useColorScheme();
  const setColorSchemeRef = useRef(setColorScheme);
  const [session, setSessionState] = useState<AuthSession>({ status: 'restoring' });
  const [appearance, setAppearance] = useState<AppearancePreference>('system');
  const [profileSettings, setProfileSettings] = useState<ProfileSettings>({ ...DEFAULT_PROFILE_SETTINGS });
  const [pendingProfileEmail, setPendingProfileEmail] = useState<string | null>(null);
  const sessionRef = useRef<AuthSession>(session);
  const operationRef = useRef(false);
  const sequenceRef = useRef(0);

  const setSession = useCallback((next: AuthSession) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  useEffect(() => {
    setColorSchemeRef.current = setColorScheme;
  }, [setColorScheme]);

  useEffect(() => {
    let active = true;
    void (async () => {
      let appearanceNotice: string | undefined;
      try {
        const savedAppearance = await appSettings.getAppearance();
        if (active) {
          setAppearance(savedAppearance);
          setColorSchemeRef.current(savedAppearance);
        }
      } catch {
        appearanceNotice = 'Appearance preference could not be loaded; using the system theme.';
        if (active) setColorSchemeRef.current('system');
      }
      try {
        const stored = await readSessionId();
        if (!stored.userId) {
          if (active) setSession({ status: 'signedOut', ...(appearanceNotice ? { notice: appearanceNotice } : {}) });
          return;
        }
        const found = await localDb.user.findById(stored.userId);
        if (!active) return;
        const decision = decideRestoredSession({ savedUserId: stored.userId, signedOutMarker: stored.signedOutMarker, profileExists: found !== null });
        if (decision === 'signedOut' || !found) {
          let notice = 'Your saved profile is unavailable. Sign in again.';
          if (Platform.OS === 'web') {
            window.localStorage.removeItem(SESSION_KEY);
            window.sessionStorage.removeItem(SESSION_KEY);
          } else {
            try {
              await SecureStore.setItemAsync(SIGNED_OUT_KEY, '1');
              await SecureStore.deleteItemAsync(SESSION_KEY);
            } catch {
              notice += ' Secure storage could not clear the stale session; verify sign-in is required before using this device.';
            }
          }
          setSession({ status: 'signedOut', notice });
          return;
        }
        // Remember me persists the local session across a browser refresh or app restart.
        // The inactivity lock below still protects a session after an extended absence.
        let savedProfileSettings = { ...DEFAULT_PROFILE_SETTINGS };
        let settingsNotice: string | undefined;
        try { savedProfileSettings = await appSettings.getProfile(found.id); }
        catch { settingsNotice = 'Security preferences could not be read. HouseLog is locked until you verify this profile password.'; }
        if (!active) return;
        setProfileSettings(savedProfileSettings);
        const notice = settingsNotice ?? appearanceNotice;
        const restoredStatus = decideRestoredSession({
          savedUserId: stored.userId,
          signedOutMarker: stored.signedOutMarker,
          profileExists: true,
          appLockEnabled: settingsNotice !== undefined || savedProfileSettings.appLockEnabled,
          // Web refreshes are navigation, not a fresh native launch. Keep the
          // remembered browser session open; Android/iOS still cold-start locked.
          coldStartLockRequired: Platform.OS !== 'web',
        });
        if (restoredStatus === 'locked') {
          setSession({ status: 'locked', user: found, ...(notice ? { notice } : { notice: 'Unlock HouseLog to continue.' }) });
        } else {
          setSession({ status: 'signedIn', user: found, ...(notice ? { notice } : {}) });
        }
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
      let savedProfileSettings = { ...DEFAULT_PROFILE_SETTINGS };
      try { savedProfileSettings = await appSettings.getProfile(result.user.id); }
      catch { notice = 'Signed in, but profile preferences could not be loaded. Defaults are active for this session.'; }
      try { await localDb.user.claimLegacyData(result.user.id); }
      catch { notice ??= 'Signed in. Older unassigned records could not be linked and were left unchanged.'; }
      try { await persistSession(result.user.id, rememberMe); }
      catch { notice = 'Signed in for this session, but the saved sign-in preference could not be updated. You may need to sign in again after closing HouseLog.'; }
      if (sequenceRef.current !== operation) return { success: false, error: 'Sign-in was cancelled. Please try again.' };
      queryClient.clear();
      setProfileSettings(savedProfileSettings);
      setPendingProfileEmail(null);
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
      const initialSettings = { ...DEFAULT_PROFILE_SETTINGS };
      try { await appSettings.setProfile(result.user.id, initialSettings); }
      catch { notice += ' Profile settings could not be saved; secure settings may need review.'; }
      try { await localDb.user.claimLegacyData(result.user.id); }
      catch { notice += ' Older unassigned records could not be linked and were left unchanged.'; }
      try { await persistSession(result.user.id, rememberMe); }
      catch { notice += ' This profile was created successfully, but the sign-in preference could not be saved. Continue this session or sign in again later.'; }
      if (sequenceRef.current !== operation) return { success: false, error: 'Sign-up was cancelled. Your profile may already exist; try signing in.' };
      queryClient.clear();
      setProfileSettings(initialSettings);
      setPendingProfileEmail(null);
      setSession({ status: 'signedIn', user: result.user, notice });
      return { success: true, notice };
    } catch {
      return { success: false, error: 'Local profile setup could not complete. Check device storage and try again.' };
    } finally { if (sequenceRef.current === operation) operationRef.current = false; }
  }, [queryClient, setSession]);

  const signOut = useCallback(async () => {
    const current = sessionRef.current;
    const ownerId = current.status === 'signedIn' || current.status === 'locked' ? current.user.id : null;
    ++sequenceRef.current;
    operationRef.current = false;
    queryClient.clear();
    setSession({ status: 'signedOut' });
    const failures: string[] = [];
    try { await persistSignedOut(); }
    catch {
      failures.push('Secure storage could not confirm removal of the saved profile. Reopen HouseLog and verify sign-in is required.');
      if (Platform.OS !== 'web') {
        try { await SecureStore.deleteItemAsync(SESSION_KEY); }
        catch { failures.push('Secure storage also rejected the session removal attempt; this device may restore the saved session when reopened.'); }
      }
    }
    if (ownerId) {
      try { await cancelProfileReminders(ownerId); }
      catch (error) { failures.push(error instanceof Error ? error.message : 'Some local reminders could not be removed.'); }
    }
    setProfileSettings({ ...DEFAULT_PROFILE_SETTINGS });
    setSession({ status: 'signedOut', ...(failures.length ? { notice: failures.join(' ') } : {}) });
  }, [queryClient, setSession]);

  const updateAppearance = useCallback(async (next: AppearancePreference) => {
    await appSettings.setAppearance(next);
    setColorScheme(next);
    setAppearance(next);
  }, [setColorScheme]);

  const updateProfileSettings = useCallback(async (patch: Partial<ProfileSettings>) => {
    const current = sessionRef.current;
    if (current.status !== 'signedIn') throw new Error('Unlock this profile before changing its settings.');
    const next = { ...profileSettings, ...patch };
    if (!next.appLockEnabled) next.biometricUnlockEnabled = false;
    await appSettings.setProfile(current.user.id, next);
    setProfileSettings(next);
    if (!next.remindersEnabled) await cancelProfileReminders(current.user.id);
  }, [profileSettings]);

  const switchLocalProfile = useCallback(async (profileId: string) => {
    const current = sessionRef.current;
    if (current.status !== 'signedIn') throw new Error('Unlock this profile before switching.');
    const profiles = await localDb.user.findMany();
    const selected = resolveProfileSwitchTarget(profiles, current.user.id, profileId);
    setPendingProfileEmail(selected.email);
    await signOut();
  }, [signOut]);

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
    const latest = sessionRef.current;
    if (latest.status !== 'locked' || latest.user.id !== locked.user.id) {
      return { success: false, error: 'The active profile changed. Please reopen its unlock screen and try again.' };
    }
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
      appearance, profileSettings, pendingProfileEmail, updateAppearance, updateProfileSettings, switchLocalProfile,
      signIn, signUp, signOut, lock, unlockWithPassword, unlockAfterBiometric, changePassword, updateProfileName, listProfiles,
    };
  }, [session, signIn, signUp, signOut, lock, unlockWithPassword, unlockAfterBiometric, changePassword, updateProfileName, listProfiles, appearance, profileSettings, pendingProfileEmail, updateAppearance, updateProfileSettings, switchLocalProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
