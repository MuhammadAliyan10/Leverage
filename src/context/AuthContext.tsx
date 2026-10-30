import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
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
import { authTraceEvent, authTraceOperation, finishAuthTrace } from '../security/authDiagnostics';

const SESSION_KEY = 'houselog_user_id';
const SIGNED_OUT_KEY = 'houselog_signed_out';
const AUTH_OPERATION_DEADLINE_MS = 25_000;
type SessionUser = Omit<DbUser, 'passwordHash'>;

/** Also bounds auth-client storage hooks, which run after the HTTP request resolves. */
function withAuthenticationDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Neon Auth did not finish within 25 seconds. Check the connection and try again.')), AUTH_OPERATION_DEADLINE_MS);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

export type AuthSession =
  | { status: 'restoring' }
  | { status: 'restoreError'; message: string }
  | { status: 'signedOut'; notice?: string }
  | { status: 'locked'; user: SessionUser; notice?: string }
  | { status: 'signedIn'; user: SessionUser; notice?: string };

interface AuthContextValue {
  session: AuthSession;
  status: AuthSession['status'];
  user: SessionUser | null;
  isLoading: boolean;
  restoreError: string | null;
  retrySessionRestore: () => void;
  sessionNotice: string | null;
  appearance: AppearancePreference;
  profileSettings: ProfileSettings;
  pendingProfileEmail: string | null;
  updateAppearance: (appearance: AppearancePreference) => Promise<void>;
  updateProfileSettings: (patch: Partial<ProfileSettings>) => Promise<void>;
  switchLocalProfile: (profileId: string) => Promise<void>;
  signIn: (email: string, password: string, rememberMe: boolean, traceId?: string) => Promise<{ success: boolean; error?: string; passwordUpgradePending?: boolean }>;
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

async function readSessionId(onStage?: (stage: string) => void): Promise<{ userId: string | null; signedOutMarker: boolean }> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return { userId: null, signedOutMarker: false };
    const signedOutMarker = window.localStorage.getItem(SIGNED_OUT_KEY) === '1';
    return { userId: signedOutMarker ? null : window.localStorage.getItem(SESSION_KEY) ?? window.sessionStorage.getItem(SESSION_KEY), signedOutMarker };
  }
  onStage?.('secure_signed_out_marker_read');
  const signedOutMarker = await SecureStore.getItemAsync(SIGNED_OUT_KEY) === '1';
  if (signedOutMarker) return { userId: null, signedOutMarker };
  onStage?.('secure_session_id_read');
  return { userId: await SecureStore.getItemAsync(SESSION_KEY), signedOutMarker };
}

function sanitizedRestoreError(error: unknown): { errorName: string; errorCode?: string; errorKind: string } {
  const value = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const errorName = typeof value?.name === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,39}$/.test(value.name) ? value.name : 'Error';
  const errorCode = typeof value?.code === 'string' && /^[A-Z0-9_.-]{1,40}$/i.test(value.code) ? value.code : undefined;
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : '';
  const errorKind = /keychain|secure.?store/.test(message) ? 'secure_storage'
    : /sqlite|database|cipher|decrypt/.test(message) ? 'local_database'
      : /network|fetch|connect|dns|socket/.test(message) ? 'network'
        : 'operation_failed';
  return { errorName, ...(errorCode ? { errorCode } : {}), errorKind };
}

async function persistSession(userId: string, rememberMe: boolean): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') throw new Error('Browser storage is unavailable.');
    if (rememberMe) {
      window.localStorage.setItem(SESSION_KEY, userId);
      window.sessionStorage.removeItem(SESSION_KEY);
      window.localStorage.removeItem(SIGNED_OUT_KEY);
    } else {
      window.localStorage.removeItem(SESSION_KEY);
      window.localStorage.removeItem(SIGNED_OUT_KEY);
      window.sessionStorage.setItem(SESSION_KEY, userId);
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

async function attachAuthenticatedCloudProfile(
  ownerId: string,
  cloudUserId: string,
  email: string,
  password: string,
  traceId?: string,
  localPasswordAlreadySet = false,
): Promise<string | undefined> {
  const imported = await authTraceOperation(traceId, 'SQLITE_IDENTITY_LINK', () => localDb.cloudIdentity.linkProfileAndQueueCoreImport({ ownerId, cloudUserId }));
  if (!localPasswordAlreadySet) {
    await authTraceOperation(traceId, 'SQLITE_LOCAL_CREDENTIAL_UPDATE', () => localDb.user.setPasswordAfterCloudAuthentication({ ownerId, cloudUserId, email, password }));
  }
  return imported.unsupportedRecords > 0
    ? `Cloud account linked and cash ledger import queued. ${imported.unsupportedRecords} other financial records remain on this device and are not cloud-synced yet.`
    : undefined;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { setColorScheme } = useColorScheme();
  const setColorSchemeRef = useRef(setColorScheme);
  const [session, setSessionState] = useState<AuthSession>({ status: 'restoring' });
  const [restoreAttempt, setRestoreAttempt] = useState(0);
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

  useEffect(() => {
    if (session.status !== 'signedIn' || !profileSettings.appLockEnabled) return;
    const profileId = session.user.id;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'inactive' || state === 'background') {
        void appSettings.setLastBackgroundAt(profileId, Date.now()).catch(() => undefined);
      } else if (state === 'active') {
        void appSettings.clearLastBackgroundAt(profileId).catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [session.status, session.status === 'signedIn' ? session.user.id : null, profileSettings.appLockEnabled]);

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
      let restoreStage = 'appearance_preferences';
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
        restoreStage = 'secure_session_read';
        const stored = await readSessionId((stage) => { restoreStage = stage; });
        if (!stored.userId) {
          if (active) setSession({ status: 'signedOut', ...(appearanceNotice ? { notice: appearanceNotice } : {}) });
          return;
        }
        restoreStage = 'local_profile_database_read';
        const found = await localDb.user.findById(stored.userId);
        if (!active) return;
        const decision = decideRestoredSession({ savedUserId: stored.userId, signedOutMarker: stored.signedOutMarker, profileExists: found !== null });
        if (decision === 'signedOut' || !found) {
          // A saved session pointer with a missing profile is not evidence that the
          // user logged out. Keep it intact and offer recovery instead of showing
          // the login form or silently discarding the device session.
          if (stored.signedOutMarker) {
            setSession({ status: 'signedOut' });
          } else {
            console.error('[Leverage] Session restore stopped', JSON.stringify({ stage: 'local_profile_missing', platform: Platform.OS }));
            setSession({ status: 'restoreError', message: 'This device could not find the profile attached to its saved session. Your cloud account and local records were not deleted. Retry, or choose “Sign out” to sign in online and download your cloud profile.' });
          }
          return;
        }
        // Remember me persists the local session across a browser refresh or app restart.
        // The inactivity lock below still protects a session after an extended absence.
        let savedProfileSettings = { ...DEFAULT_PROFILE_SETTINGS };
        let settingsNotice: string | undefined;
        restoreStage = 'profile_security_preferences';
        try { savedProfileSettings = await appSettings.getProfile(found.id); }
        catch { settingsNotice = 'Security preferences could not be read. Leverage is locked until you verify this profile password.'; }
        if (!active) return;
        setProfileSettings(savedProfileSettings);
        const notice = settingsNotice ?? appearanceNotice;
        restoreStage = 'session_policy';
        const restoredStatus = decideRestoredSession({
          savedUserId: stored.userId,
          signedOutMarker: stored.signedOutMarker,
          profileExists: true,
          appLockEnabled: settingsNotice !== undefined || savedProfileSettings.appLockEnabled,
          lastBackgroundAt: await appSettings.getLastBackgroundAt(found.id).catch(() => null),
        });
        if (restoredStatus === 'signedIn') await appSettings.clearLastBackgroundAt(found.id).catch(() => undefined);
        if (restoredStatus === 'locked') {
          setSession({ status: 'locked', user: found, ...(notice ? { notice } : { notice: 'Unlock Leverage to continue.' }) });
        } else {
          setSession({ status: 'signedIn', user: found, ...(notice ? { notice } : {}) });
        }
      } catch (error) {
        if (active) {
          console.error('[Leverage] Session restore failed', JSON.stringify({ stage: restoreStage, platform: Platform.OS, ...sanitizedRestoreError(error) }));
          setSession({ status: 'restoreError', message: 'Leverage could not reopen the saved profile on this device. Your saved session and financial records were not intentionally changed. Tap Retry. If this continues, use the encrypted backup recovery option or choose Sign out to authenticate online again.' });
        }
      }
    })();
    return () => { active = false; };
  }, [setSession, restoreAttempt]);

  const retrySessionRestore = useCallback(() => {
    setSession({ status: 'restoring' });
    setRestoreAttempt((attempt) => attempt + 1);
  }, [setSession]);

  const signIn = async (email: string, password: string, rememberMe: boolean, traceId?: string) => {
    if (operationRef.current) {
      authTraceEvent('LOGIN_REJECTED_CONCURRENT', {}, traceId);
      finishAuthTrace(false, 'concurrent_auth_operation', traceId);
      return { success: false, error: 'Authentication is already in progress. Please wait.' };
    }
    operationRef.current = true;
    const operation = ++sequenceRef.current;
    let loginSuccess = false;
    try {
      let result: Awaited<ReturnType<typeof localDb.user.signIn>>;
      let cloudLinkNotice: string | undefined;
      let localPasswordAlreadySet = false;
      const network = await authTraceOperation(traceId, 'NETWORK_CHECK', () => Network.getNetworkStateAsync()).catch(() => null);
      const online = network?.isConnected === true && network.isInternetReachable !== false;
      if (!online) {
        result = await authTraceOperation(traceId, 'SQLITE_OFFLINE_AUTH', () => localDb.user.signIn(email, password));
        if (!result.success) return { success: false, error: 'This device has no saved profile for offline sign-in. Connect to the internet and sign in once first.' };
      } else {
        if (!cloudApiConfigured) return { success: false, error: 'Cloud sign-in is not configured in this app build. No local-only sign-in was attempted while online.' };

        // Keep the existing device ID for auth-session storage, but do not create a
        // local profile until Neon has authenticated these credentials.
        let localUser = await authTraceOperation(traceId, 'SQLITE_PROFILE', () => localDb.user.findByEmail(email));
        const ownerId = localUser?.id ?? Crypto.randomUUID();
        const cloud = getCloudAuthClient(ownerId);
        let remote: Awaited<ReturnType<typeof cloud.signIn.email>>;
        try {
          remote = await authTraceOperation(traceId, 'NEON_AUTH', () => withAuthenticationDeadline(cloud.signIn.email({ email: email.trim().toLowerCase(), password, rememberMe })));
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Neon Auth did not finish')) {
            return { success: false, error: 'Cloud sign-in timed out after 25 seconds. Check your connection and try again.' };
          }
          return { success: false, error: `Cloud sign-in could not reach Neon Auth: ${error instanceof Error ? error.message : 'Check your internet connection and try again.'}` };
        }
        if (remote.error || !remote.data?.user?.id) {
          authTraceEvent('NEON_AUTH_REJECTED', {
            hasHttpStatus: typeof remote.error?.status === 'number',
            ...(typeof remote.error?.status === 'number' ? { httpStatus: remote.error.status } : {}),
            hasErrorCode: typeof remote.error?.code === 'string',
          }, traceId);
          return { success: false, error: remote.error?.message ?? 'Cloud sign-in did not return an authenticated account.' };
        }

        if (!localUser) {
          const displayName = email.trim().split('@')[0] || 'Leverage user';
          const local = await authTraceOperation(traceId, 'SQLITE_PROFILE_CREATE', () => localDb.user.register(displayName, email, password, ownerId));
          if (!local.success) {
            await cloud.signOut().catch(() => undefined);
            return { success: false, error: `Cloud sign-in succeeded, but this device could not prepare its local profile: ${local.error} Your cloud account is unchanged; resolve local storage and sign in again.` };
          }
          localUser = local.user;
          localPasswordAlreadySet = true;
        }

        try {
          cloudLinkNotice = await attachAuthenticatedCloudProfile(localUser.id, remote.data.user.id, email, password, traceId, localPasswordAlreadySet);
        } catch (error) {
          await cloud.signOut().catch(() => undefined);
          return { success: false, error: error instanceof Error ? `${error.message} Cloud authentication succeeded; sign in again to retry linking this device.` : 'Cloud authentication succeeded, but this device could not be linked. Sign in again to retry.' };
        }
        const refreshed = await authTraceOperation(traceId, 'SQLITE_PROFILE_RELOAD', () => localDb.user.findById(localUser!.id));
        if (!refreshed) return { success: false, error: 'Cloud authentication succeeded, but the local profile could not be loaded. Your cloud account is unchanged.' };
        result = { success: true, user: refreshed, passwordUpgradePending: false };
      }
      let notice: string | undefined = typeof cloudLinkNotice === 'string' ? cloudLinkNotice : undefined;
      let savedProfileSettings = { ...DEFAULT_PROFILE_SETTINGS };
      try { savedProfileSettings = await authTraceOperation(traceId, 'PROFILE_SETTINGS', () => appSettings.getProfile(result.user.id)); }
      catch { notice = 'Signed in, but profile preferences could not be loaded. Defaults are active for this session.'; }
      try { await authTraceOperation(traceId, 'SQLITE_LEGACY_CLAIM', () => localDb.user.claimLegacyData(result.user.id)); }
      catch { notice ??= 'Signed in. Older unassigned records could not be linked and were left unchanged.'; }
      try { await authTraceOperation(traceId, 'SESSION_STORAGE', () => persistSession(result.user.id, rememberMe)); }
      catch { notice = 'Signed in for this session, but the saved sign-in preference could not be updated. You may need to sign in again after closing Leverage.'; }
      if (sequenceRef.current !== operation) return { success: false, error: 'Sign-in was cancelled. Please try again.' };
      await appSettings.clearLastBackgroundAt(result.user.id).catch(() => undefined);
      queryClient.clear();
      setProfileSettings(savedProfileSettings);
      setPendingProfileEmail(null);
      setSession({ status: 'signedIn', user: result.user, ...(notice ? { notice } : {}) });
      authTraceEvent('AUTH_STATE_UPDATE', { status: 'signedIn' }, traceId);
      authTraceEvent('AUTH_CONTEXT_RETURN', { success: true }, traceId);
      loginSuccess = true;
      return { success: true, passwordUpgradePending: result.passwordUpgradePending };
    } catch (error) {
      authTraceEvent('LOGIN_ERROR', { errorKind: error instanceof Error ? 'operation_failed' : 'unknown' }, traceId);
      finishAuthTrace(false, 'sign_in_failed', traceId);
      return { success: false, error: getLocalAuthFailureMessage(error, 'sign-in') };
    } finally {
      if (sequenceRef.current === operation) operationRef.current = false;
      authTraceEvent('AUTH_OPERATION_FINALLY', { success: loginSuccess }, traceId);
      if (!loginSuccess && traceId) finishAuthTrace(false, 'sign_in_not_completed', traceId);
    }
  };

  const signUp = async (fullName: string, email: string, password: string, rememberMe: boolean) => {
    if (operationRef.current) return { success: false, error: 'Authentication is already in progress. Please wait.' };
    operationRef.current = true;
    const operation = ++sequenceRef.current;
    try {
      if (!cloudApiConfigured) return { success: false, error: 'Cloud registration is not configured in this app build. Connect this build to Neon before creating an account.' };
      const network = await Network.getNetworkStateAsync().catch(() => null);
      if (network?.isConnected !== true || network.isInternetReachable === false) return { success: false, error: 'Connect to the internet to create your cloud account.' };

      // This read preserves an existing device profile and its history. Neon creates
      // the account before this flow writes any new local profile data.
      const existing = await localDb.user.findByEmail(email);
      const existingLocalProfile = existing !== null;
      const preserveProfileSettings = existingLocalProfile;
      const ownerId = existing?.id ?? Crypto.randomUUID();
      const cloud = getCloudAuthClient(ownerId);
      let remote: Awaited<ReturnType<typeof cloud.signUp.email>>;
      try {
        remote = await withAuthenticationDeadline(cloud.signUp.email({ name: fullName, email: email.trim().toLowerCase(), password }));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Neon Auth did not finish')) {
          return { success: false, error: 'Cloud registration timed out after 25 seconds. Your account may have been created; try signing in before registering again.' };
        }
        return { success: false, error: `Cloud registration could not reach Neon Auth: ${error instanceof Error ? error.message : 'Check your internet connection and try again.'}` };
      }
      if (remote.error || !remote.data?.user?.id) {
        return { success: false, error: remote.error?.message ?? 'Cloud sign-up did not return an authenticated account.' };
      }

      let profile = existing;
      let localPasswordAlreadySet = false;
      if (!profile) {
        const local = await localDb.user.register(fullName, email, password, ownerId);
        if (!local.success) {
          await cloud.signOut().catch(() => undefined);
          return { success: false, error: `Your cloud account was created, but this device could not save its local profile: ${local.error} Fix local storage, then sign in to finish linking this device.` };
        }
        profile = local.user;
        localPasswordAlreadySet = true;
      }

      let cloudLinkNotice: string | undefined;
      try {
        cloudLinkNotice = await attachAuthenticatedCloudProfile(profile.id, remote.data.user.id, email, password, undefined, localPasswordAlreadySet);
      } catch (error) {
        await cloud.signOut().catch(() => undefined);
        return { success: false, error: error instanceof Error ? `${error.message} Your cloud account remains created; sign in again to retry linking this device.` : 'Your cloud account remains created, but this device could not be linked. Sign in again to retry.' };
      }
      try { await localDb.user.requireOnboarding(profile.id); }
      catch { cloudLinkNotice ??= 'Your cloud account is connected. First-run setup could not be saved on this device; you can create an account from the dashboard.'; }
      const authenticatedLocalProfile = await localDb.user.findById(profile.id);
      if (!authenticatedLocalProfile) return { success: false, error: 'Cloud account created, but the device profile could not be loaded. Sign in again to retry.' };
      const result: Awaited<ReturnType<typeof localDb.user.register>> = { success: true, user: authenticatedLocalProfile, passwordUpgradePending: false };
      let notice: string | undefined = cloudLinkNotice;
      if (existingLocalProfile && !notice) notice = 'Cloud account created and linked to your existing device profile.';
      notice ??= 'Cloud account created and linked to this device.';
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
      await appSettings.clearLastBackgroundAt(result.user.id).catch(() => undefined);
      queryClient.clear();
      setProfileSettings(initialSettings);
      setPendingProfileEmail(null);
      setSession({ status: 'signedIn', user: result.user, notice });
      return { success: true, notice };
    } catch (error) {
      return { success: false, error: getLocalAuthFailureMessage(error, 'sign-up') };
    } finally { if (sequenceRef.current === operation) operationRef.current = false; }
  };

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
      failures.push('Secure storage could not confirm removal of the saved profile. Reopen Leverage and verify sign-in is required.');
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
    setSession({ status: 'locked', user: current.user, notice: 'Unlock Leverage to continue.' });
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
    await appSettings.clearLastBackgroundAt(locked.user.id).catch(() => undefined);
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
  const restoreError = session.status === 'restoreError' ? session.message : null;
  const sessionNotice = session.status === 'signedIn' || session.status === 'locked' || session.status === 'signedOut' ? session.notice ?? null : null;
  const value: AuthContextValue = {
    session, status: session.status, user: currentUser, isLoading: session.status === 'restoring', restoreError, retrySessionRestore, sessionNotice,
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
