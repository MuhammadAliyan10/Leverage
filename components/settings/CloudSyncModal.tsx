import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { cloudApiConfigured, cloudFetch, getCloudAuthClient } from '../../src/cloud/authClient';
import { localDb } from '../../src/db/local/client';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import { getCloudSyncState, subscribeCloudSyncState, syncOfflineData, type CloudSyncState } from '../../utils/syncEngine';

type Props = { visible: boolean; ownerId: string; fullName: string; onClose: () => void };
type Identity = { cloudUserId: string; linkedAt: string; syncEnabled: boolean } | null;
type RejectedItem = { mutationId:string;entityType:string;entityId:string;operation:string;errorCategory:string|null;createdAt:string };

function syncFailureMessage(state: CloudSyncState): string {
  if (state === 'auth_required') return 'Cloud sign-in is required again. Local records and pending changes remain on this device.';
  if (state === 'action_required') return 'Some cloud changes need review. Local records remain safe on this device; check the rejected records below.';
  if (state === 'offline') return 'Cloud sync could not reach the service. Local records and pending changes remain on this device; retry when online.';
  return 'Cloud sync did not complete. Local records and pending changes remain on this device; use Sync now to retry.';
}

export function CloudSyncModal({ visible, ownerId, fullName, onClose }: Props) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [identity, setIdentity] = useState<Identity>(null);
  const [pending, setPending] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [rejectedItems, setRejectedItems] = useState<RejectedItem[]>([]);
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<CloudSyncState>('not_configured');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [saved, count, rejectedCount, failed, lastSync] = await Promise.all([localDb.cloudIdentity.get(ownerId), localDb.syncOutbox.pendingCount(ownerId), localDb.syncOutbox.rejectedCount(ownerId), localDb.syncOutbox.rejectedItems(ownerId), localDb.syncOutbox.lastSuccessfulAt(ownerId)]);
    setIdentity(saved);
    setPending(count);
    setRejected(rejectedCount);
    setRejectedItems(failed);
    setLastSuccessfulAt(lastSync);
    setSyncState(getCloudSyncState(ownerId));
  }, [ownerId]);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => { void refresh().catch(() => setError('Cloud sync status could not be loaded.')); }, 0);
    return () => clearTimeout(timer);
  }, [visible, refresh]);
  useEffect(() => subscribeCloudSyncState((profileId,state) => { if (profileId === ownerId) setSyncState(state); }), [ownerId]);

  const connect = async (create: boolean) => {
    setBusy(true); setError(null);
    try {
      if (!cloudApiConfigured) throw new Error('This build has no Neon Auth and Data API endpoints. Configure EXPO_PUBLIC_NEON_AUTH_URL and EXPO_PUBLIC_NEON_DATA_API_URL, then rebuild the app.');
      if (Platform.OS === 'web') throw new Error('Cloud account connection is available in the Android or iOS app.');
      const authClient = getCloudAuthClient(ownerId);
      if (create) {
        const result = await authClient.signUp.email({ name: fullName, email: email.trim(), password });
        if (result.error) throw new Error(result.error.message || 'Cloud sign-up failed.');
      } else {
        const result = await authClient.signIn.email({ email: email.trim(), password });
        if (result.error) throw new Error(result.error.message || 'Cloud sign-in failed.');
      }
      const response = await cloudFetch(ownerId,'/api/v1/sync/identity');
      if (!response.ok) throw new Error(response.status === 401 ? 'Cloud session could not be verified.' : 'Cloud identity could not be verified.');
      const body = await response.json() as { userId?: string };
      if (typeof body.userId !== 'string' || !body.userId) throw new Error('The server returned an invalid cloud identity.');
      const imported = await localDb.cloudIdentity.linkProfileAndQueueCoreImport({ ownerId, cloudUserId: body.userId });
          if (imported.unsupportedRecords > 0) setError(`${imported.unsupportedRecords} records could not be queued for cloud import and remain on this device. Review the affected records and try again.`);
      await refresh();
      void syncOfflineData(ownerId).then(async (complete) => {
        await refresh();
        await queryClient.invalidateQueries();
        if (!complete) setError(syncFailureMessage(getCloudSyncState(ownerId)));
      }).catch(() => {
        setError('Cloud account connected, but sync did not finish. Pending records remain on this device; use Sync now to retry.');
      });
      setPassword('');
    } catch (cause) {
      if (cloudApiConfigured) await getCloudAuthClient(ownerId).signOut().catch(() => undefined);
      setError(cause instanceof Error ? cause.message : 'Cloud account connection failed.');
    } finally { setBusy(false); }
  };

  const syncNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const complete = await syncOfflineData(ownerId);
      await refresh();
      await queryClient.invalidateQueries();
      if (!complete) setError(syncFailureMessage(getCloudSyncState(ownerId)));
    } catch {
      setError('Sync failed. Pending records remain on this device; check your connection and retry.');
    } finally {
      setBusy(false);
    }
  };

  const disconnectSession = async () => {
    setBusy(true); setError(null);
    try { await getCloudAuthClient(ownerId).signOut(); setError('Cloud session signed out. The local profile and pending records remain on this device.'); }
    catch { setError('The local app remains available, but the cloud session could not be revoked. Try again when online.'); }
    finally { setBusy(false); }
  };

  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
    <View className="flex-1 justify-end bg-black/40">
      <View className="rounded-t-3xl bg-white px-5 pb-8 pt-5 dark:bg-neutral-900">
        <View className="mb-4 flex-row items-center justify-between"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Cloud sync</Text><Pressable accessibilityRole="button" onPress={onClose}><Text className="font-body text-sm font-semibold text-primary">Close</Text></Pressable></View>
        {identity ? <>
          <Text className="font-body text-sm text-gray-800 dark:text-neutral-100">Cloud identity connected</Text>
          <Text className="font-body mt-2 text-xs leading-5 text-gray-500 dark:text-neutral-400">Status: {syncState.replaceAll('_',' ')} · {pending} pending · {rejected} need attention</Text>
          <Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Last successful sync: {lastSuccessfulAt ? new Date(lastSuccessfulAt).toLocaleString() : 'Not yet synced'}</Text>
          <Text className="font-body mt-2 text-xs leading-5 text-gray-500 dark:text-neutral-400">Leverage saves changes on this device first, then sends supported records to Neon when connected. Items still waiting or needing attention stay on this device. Check the sync status before using another device.</Text>
          {rejectedItems.length ? <View className="mt-3 border border-amber-300 p-3 dark:border-amber-800">
            <Text className="font-body text-xs font-semibold text-amber-800 dark:text-amber-200">Some local records need review. They remain in this device’s history.</Text>
            {rejectedItems.map((item) => <Text key={item.mutationId} className="font-body mt-2 text-xs leading-5 text-amber-800 dark:text-amber-200">{item.operation.replaceAll('.', ' ')} · {item.errorCategory ?? 'needs_review'} · {item.entityId}</Text>)}
            {rejected > rejectedItems.length ? <Text className="font-body mt-1 text-xs text-amber-800 dark:text-amber-200">And {rejected - rejectedItems.length} more.</Text> : null}
          </View> : null}
          <Pressable disabled={busy || syncState === 'syncing'} onPress={() => void syncNow()} className="mt-5 min-h-12 items-center justify-center bg-primary px-4">{busy || syncState === 'syncing' ? <ActivityIndicator color="#fff" /> : <Text className="font-body font-semibold text-white">Sync now</Text>}</Pressable>
          <Pressable disabled={busy} onPress={() => void disconnectSession()} className="mt-2 min-h-11 items-center justify-center border border-primary px-4"><Text className="font-body font-semibold" style={{ color: PRIMARY_COLOR }}>Sign out of cloud</Text></Pressable>
        </> : <>
          <Text className="font-body mb-4 text-xs leading-5 text-gray-500 dark:text-neutral-400">Link this profile to your cloud account. Existing supported records will be queued, and new changes will sync after they are saved here. Keep using this device until the status confirms they have synced.</Text>
          <Text className="font-body mb-1 text-xs font-semibold text-gray-700 dark:text-neutral-200">Cloud account email</Text>
          <TextInput accessibilityLabel="Cloud account email" autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} className="mb-3 min-h-12 border border-gray-200 px-3 text-gray-900 dark:border-neutral-700 dark:text-white" />
          <Text className="font-body mb-1 text-xs font-semibold text-gray-700 dark:text-neutral-200">Cloud account password</Text>
          <TextInput accessibilityLabel="Cloud account password" autoComplete="password" secureTextEntry value={password} onChangeText={setPassword} className="mb-2 min-h-12 border border-gray-200 px-3 text-gray-900 dark:border-neutral-700 dark:text-white" />
          {error ? <Text accessibilityRole="alert" className="font-body mt-2 text-xs leading-5 text-red-600">{error}</Text> : null}
          <Pressable disabled={busy} onPress={() => void connect(false)} className="mt-4 min-h-12 items-center justify-center bg-primary px-4">{busy ? <ActivityIndicator color="#fff" /> : <Text className="font-body font-semibold text-white">Sign in and connect</Text>}</Pressable>
          <Pressable disabled={busy} onPress={() => void connect(true)} className="mt-2 min-h-11 items-center justify-center border border-primary px-4"><Text className="font-body font-semibold" style={{ color: PRIMARY_COLOR }}>Create cloud account and connect</Text></Pressable>
        </>}
        {error && identity ? <Text accessibilityRole="alert" className="font-body mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">{error}</Text> : null}
      </View>
    </View>
  </Modal>;
}
