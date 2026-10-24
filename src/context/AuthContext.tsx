import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import { useColorScheme } from 'nativewind';
import { localDb, DbUser } from '../db/local/client';
import { decideRestoredSession } from '../security/sessionPolicy';
import { appSettings } from '../security/appSettings';
import { DEFAULT_PROFILE_SETTINGS, type AppearancePreference, type ProfileSettings } from '../security/settingsPreferences';
import { cancelProfileReminders } from '../security/localReminders';
import { resolveProfileSwitchTarget } from '../security/profileSwitchPolicy';
import { getLocalAuthFailureMessage } from '../security/localAuthError';
import { cancelCloudSync, syncOfflineData } from '../../utils/syncEngine';
import { setSyncWakeHandler } from '../db/local/syncOutbox';
import { clearNeonToken, cloudApiConfigured, getCloudAuthClient } from '../cloud/authClient';

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
  restoreBackup: (envelope: Uint8Array, passphrase: string) => Promise<void>;
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

async function attachAuthenticatedCloudProfile(ownerId: string, cloudUserId: string, email: string, password: string): Promise<string | undefined> {
  const imported = await localDb.cloudIdentity.linkProfileAndQueueCoreImport({ ownerId, cloudUserId });
  await localDb.user.setPasswordAfterCloudAuthentication({ ownerId, cloudUserId, email, password });
  return imported.unsupportedRecords > 0
    ? `Cloud account linked and cash ledger import queued. ${imported.unsupportedRecords} other financial records remain on this device and are not cloud-synced yet.`
    : undefined;
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

  const syncAndRefreshLocalQueries = useCallback((ownerId: string) => {
    void syncOfflineData(ownerId).then(
      () => { void queryClient.invalidateQueries(); },
      () => { void queryClient.invalidateQueries(); },
    );
  }, [queryClient]);

  useEffect(() => {
    setSyncWakeHandler(syncAndRefreshLocalQueries);
    return () => setSyncWakeHandler(null);
  }, [syncAndRefreshLocalQueries]);

  const cloudSyncOwnerId = session.status === 'signedIn' ? session.user.id : null;
  useEffect(() => {
    if (!cloudSyncOwnerId) return;
    syncAndRefreshLocalQueries(cloudSyncOwnerId);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') syncAndRefreshLocalQueries(cloudSyncOwnerId);
    });
    const networkSubscription = Network.addNetworkStateListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) syncAndRefreshLocalQueries(cloudSyncOwnerId);
    });
    return () => {
      appStateSubscription.remove();
      networkSubscription.remove();
      cancelCloudSync(cloudSyncOwnerId);
    };
  }, [cloudSyncOwnerId, syncAndRefreshLocalQueries]);

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
        catch { settingsNotice = 'Security preferences could not be read. Mizan is locked until you verify this profile password.'; }
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
          setSession({ status: 'locked', user: found, ...(notice ? { notice } : { notice: 'Unlock Mizan to continue.' }) });
        } else {
          setSession({ status: 'signedIn', user: found, ...(notice ? { notice } : {}) });
        }
      } catch {
        if (active) setSession({ status: 'signedOut', notice: 'Your saved session could not be restored. Sign in again; your records were not changed.' });
      }
    })();
    return () => { active = false; };
  }, [setSession]);

  const signIn = async (email: string, password: string, rememberMe: boolean) => {
    if (operationRef.current) return { success: false, error: 'Authentication is already in progress. Please wait.' };
    operationRef.current = true;
    const operation = ++sequenceRef.current;
    try {
      let result: Awaited<ReturnType<typeof localDb.user.signIn>>;
      let cloudLinkNotice: string | undefined;
      if (cloudApiConfigured) {
        const network = await Network.getNetworkStateAsync().catch(() => null);
        const online = network?.isConnected === true && network.isInternetReachable !== false;
        if (!online) {
          result = await localDb.user.signIn(email, password);
          if (!result.success) return { success: false, error: 'This device has no saved profile for offline sign-in. Connect to the internet and sign in once first.' };
        } else {
          let localUser = await localDb.user.findByEmail(email);
          let createdShell = false;
          if (!localUser) {
            const shell = await localDb.user.register(email.trim().split('@')[0] || 'HouseLog user', email, password);
            if (!shell.success) return { success: false, error: shell.error };
            localUser = shell.user;
            createdShell = true;
          }
          const cloud = getCloudAuthClient(localUser.id);
          const remote = await cloud.signIn.email({ email: email.trim().toLowerCase(), password, rememberMe });
          if (remote.error || !remote.data?.user?.id) {
            if (createdShell) await localDb.user.discardUnlinkedEmptyProfile(localUser.id);
            return { success: false, error: remote.error?.message ?? 'Cloud sign-in did not return an authenticated account.' };
          }
          try {
            cloudLinkNotice = await attachAuthenticatedCloudProfile(localUser.id, remote.data.user.id, email, password);
          } catch (error) {
            await cloud.signOut().catch(() => undefined);
            if (createdShell) await localDb.user.discardUnlinkedEmptyProfile(localUser.id);
            return { success: false, error: error instanceof Error ? error.message : 'Cloud account could not be linked to this device profile.' };
          }
          const refreshed = await localDb.user.findById(localUser.id);
          if (!refreshed) return { success: false, error: 'The authenticated local profile could not be loaded.' };
          result = { success: true, user: refreshed, passwordUpgradePending: false };
        }
      } else {
        result = await localDb.user.signIn(email, password);
      }
      if (!result.success) return { success: false, error: result.error };
      let notice: string | undefined = typeof cloudLinkNotice === 'string' ? cloudLinkNotice : undefined;
      let savedProfileSettings = { ...DEFAULT_PROFILE_SETTINGS };
      try { savedProfileSettings = await appSettings.getProfile(result.user.id); }
      catch { notice = 'Signed in, but profile preferences could not be loaded. Defaults are active for this session.'; }
      try { await localDb.user.claimLegacyData(result.user.id); }
      catch { notice ??= 'Signed in. Older unassigned records could not be linked and were left unchanged.'; }
      try { await persistSession(result.user.id, rememberMe); }
      catch { notice = 'Signed in for this session, but the saved sign-in preference could not be updated. You may need to sign in again after closing Mizan.'; }
      if (sequenceRef.current !== operation) return { success: false, error: 'Sign-in was cancelled. Please try again.' };
      queryClient.clear();
      setProfileSettings(savedProfileSettings);
      setPendingProfileEmail(null);
      setSession({ status: 'signedIn', user: result.user, ...(notice ? { notice } : {}) });
      return { success: true, passwordUpgradePending: result.passwordUpgradePending };
    } catch (error) {
      return { success: false, error: getLocalAuthFailureMessage(error) };
    } finally { if (sequenceRef.current === operation) operationRef.current = false; }
  };

  const signUp = useCallback(async (fullName: string, email: string, password: string, rememberMe: boolean) => {
    if (operationRef.current) return { success: false, error: 'Authentication is already in progress. Please wait.' };
    operationRef.current = true;
    const operation = ++sequenceRef.current;
    try {
      let result: Awaited<ReturnType<typeof localDb.user.register>>;
      let notice: string | undefined;
      let preserveProfileSettings = false;
      if (cloudApiConfigured) {
        const network = await Network.getNetworkStateAsync().catch(() => null);
        if (network?.isConnected !== true || network.isInternetReachable === false) return { success: false, error: 'Connect to the internet to create your cloud account.' };
        let existing = await localDb.user.findByEmail(email);
        const existingLocalProfile = existing !== null;
        preserveProfileSettings = existingLocalProfile;
        if (!existing) {
          result = await localDb.user.register(fullName, email, password);
          if (!result.success) return { success: false, error: result.error };
          existing = result.user;
        }
        const cloud = getCloudAuthClient(existing.id);
        const remote = await cloud.signUp.email({ name: fullName, email: email.trim().toLowerCase(), password });
        if (remote.error || !remote.data?.user?.id) {
          if (!existingLocalProfile) await localDb.user.discardUnlinkedEmptyProfile(existing.id);
          return { success: false, error: remote.error?.message ?? 'Cloud sign-up did not return an authenticated account.' };
        }
        let cloudLinkNotice: string | undefined;
        try {
          cloudLinkNotice = await attachAuthenticatedCloudProfile(existing.id, remote.data.user.id, email, password);
        } catch (error) {
          await cloud.signOut().catch(() => undefined);
          if (!existingLocalProfile) await localDb.user.discardUnlinkedEmptyProfile(existing.id);
          return { success: false, error: error instanceof Error ? `${error.message} The cloud account was created; sign in to retry linking this device.` : 'The cloud account was created, but this device could not be linked. Sign in to retry linking.' };
        }
        const authenticatedLocalProfile = await localDb.user.findById(existing.id);
        if (!authenticatedLocalProfile) return { success: false, error: 'Cloud account created, but the device profile could not be loaded. Sign in again to retry.' };
        result = { success: true, user: authenticatedLocalProfile, passwordUpgradePending: false };
        if (existingLocalProfile) notice = cloudLinkNotice ?? 'Cloud account created and linked to your existing device profile.';
        else if (cloudLinkNotice) notice = cloudLinkNotice;
      } else {
        result = await localDb.user.register(fullName, email, password);
      }
      if (!result.success) return { success: false, error: result.error };
      notice ??= cloudApiConfigured ? 'Cloud account created. This device is linked and local changes will sync when connected.' : 'Mizan stores this profile and its financial records on this device. There is no cloud account recovery.';
      let initialSettings = { ...DEFAULT_PROFILE_SETTINGS };
      if (!preserveProfileSettings) {
        try { await appSettings.setProfile(result.user.id, initialSettings); }
        catch { notice += ' Profile settings could not be saved; secure settings may need review.'; }
      } else {
        try { initialSettings = await appSettings.getProfile(result.user.id); } catch { /* retain defaults for this session */ }
      }
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
      failures.push('Secure storage could not confirm removal of the saved profile. Reopen Mizan and verify sign-in is required.');
      if (Platform.OS !== 'web') {
        try { await SecureStore.deleteItemAsync(SESSION_KEY); }
        catch { failures.push('Secure storage also rejected the session removal attempt; this device may restore the saved session when reopened.'); }
      }
    }
    if (ownerId) {
      if (cloudApiConfigured) {
        try {
          const result = await Promise.race([
            getCloudAuthClient(ownerId).signOut(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Cloud sign-out timed out.')), 2_000)),
          ]);
          if (result.error) failures.push('The local profile signed out, but the cloud session could not be revoked. Sign out again when online.');
        } catch {
          failures.push('The local profile signed out, but cloud-session revocation could not be confirmed. Reconnect and sign out of cloud sync.');
        }
        await clearNeonToken(ownerId).catch(() => undefined);
      }
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
    setSession({ status: 'locked', user: current.user, notice: 'Unlock Mizan to continue.' });
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
    const verification = await localDb.user.verifyPassword(locked.user.id, password);
    if (!verification.success) return { success: false, error: verification.retryAfterSeconds ? `Too many attempts. Try again in ${verification.retryAfterSeconds} seconds.` : 'Password could not unlock this local profile.' };
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

  const restoreBackup = useCallback(async (envelope: Uint8Array, passphrase: string) => {
    const current = sessionRef.current;
    const expectedProfileId = current.status === 'signedIn' ? current.user.id : null;
    const restoredProfileId = await localDb.recovery.importEncryptedBackup(envelope, passphrase, expectedProfileId);
    await persistSignedOut();
    queryClient.clear();
    setProfileSettings({ ...DEFAULT_PROFILE_SETTINGS });
    setSession({ status: 'signedOut', notice: `Backup restored for ${restoredProfileId}. Sign in with that profile to continue.` });
  }, [queryClient, setSession]);

  const currentUser = session.status === 'signedIn' ? session.user : null;
  const restoreError = session.status === 'signedOut' && session.notice?.includes('could not be restored') ? session.notice : null;
  const sessionNotice = session.status === 'signedIn' || session.status === 'locked' || session.status === 'signedOut' ? session.notice === restoreError ? null : session.notice ?? null : null;
  const value: AuthContextValue = {
    session, status: session.status, user: currentUser, isLoading: session.status === 'restoring', restoreError, sessionNotice,
    appearance, profileSettings, pendingProfileEmail, updateAppearance, updateProfileSettings, switchLocalProfile,
    signIn, signUp, signOut, lock, unlockWithPassword, unlockAfterBiometric, changePassword, updateProfileName, listProfiles, restoreBackup,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
