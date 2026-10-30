import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from '../ui/KeyboardAwareScrollView';
import { Input } from '../ui/Input';
import { cloudApiConfigured, cloudFetch, getCloudAuthClient } from '../../src/cloud/authClient';
import { localDb } from '../../src/db/local/client';
import { assessAccountReconciliation, type CloudAccountReconciliationPreview, type LocalAccountConflict } from '../../src/cloud/accountReconciliation';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import { formatMinorUnits } from '../../src/finance/ledger';
import { projectSyncQueueRow, type SyncQueueRow } from '../../src/finance/syncQueueDisplay';
import { describeCloudSyncFailure, getCloudSyncFailure, getCloudSyncState, subscribeCloudSyncState, syncOfflineData, type CloudSyncState } from '../../utils/syncEngine';

type Props = { visible: boolean; ownerId: string; fullName: string; onClose: () => void };
type Identity = { cloudUserId: string; linkedAt: string; syncEnabled: boolean } | null;
function syncFailureMessage(state: CloudSyncState): string {
  if (state === 'auth_required') return 'Cloud sign-in is required again. Local records and pending changes remain on this device.';
  if (state === 'action_required') return 'Some changes did not sync. They are still saved on this device; the reason is shown with each change below.';
  if (state === 'offline') return 'Cloud sync could not reach the service. Local records and pending changes remain on this device; retry when online.';
  return 'Cloud sync did not complete. Local records and pending changes remain on this device; use Sync now to retry.';
}
function displayMinor(value: string, currency: string): string {
  const minor = Number(value);
  return Number.isSafeInteger(minor) ? formatMinorUnits(minor, currency) : `${value} minor units`;
}

export function CloudSyncModal({ visible, ownerId, fullName, onClose }: Props) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [identity, setIdentity] = useState<Identity>(null);
  const [pending, setPending] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [queueItems, setQueueItems] = useState<(SyncQueueRow & { mutationId: string })[]>([]);
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<CloudSyncState>('not_configured');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountReconciliation, setAccountReconciliation] = useState<{
    local: LocalAccountConflict & { local: { name: string; type: string; currency: string; openingBalanceMinor: string; currentBalanceMinor: string } };
    preview: CloudAccountReconciliationPreview;
    reasons: string[];
  } | null>(null);
  const showSessionHelp = syncState === 'auth_required' || queueItems.some((item) => item.status === 'rejected' && (item.errorCategory === 'AUTH_REQUIRED' || item.errorCategory === 'session_expired'));

  const refresh = useCallback(async () => {
    const [saved, count, rejectedCount, items, lastSync] = await Promise.all([localDb.cloudIdentity.get(ownerId), localDb.syncOutbox.pendingCount(ownerId), localDb.syncOutbox.rejectedCount(ownerId), localDb.syncOutbox.recentQueueItems(ownerId), localDb.syncOutbox.lastSuccessfulAt(ownerId)]);
    setIdentity(saved);
    setPending(count);
    setRejected(rejectedCount);
    setQueueItems(items);
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
      await localDb.syncOutbox.releasePendingForManualRetry(ownerId);
      const complete = await syncOfflineData(ownerId);
      await refresh();
      await queryClient.invalidateQueries();
      if (!complete) {
        const state = getCloudSyncState(ownerId);
        const detail = describeCloudSyncFailure(getCloudSyncFailure(ownerId));
        setError([syncFailureMessage(state), detail].filter(Boolean).join(' '));
      }
    } catch {
      setError('Sync failed. Pending records remain on this device; check your connection and retry.');
    } finally {
      setBusy(false);
    }
  };

  const retryRejected = async () => {
    setBusy(true);
    setError(null);
    try {
      const count = await localDb.syncOutbox.retryRejected(ownerId);
      if (!count) { await refresh(); return; }
      const complete = await syncOfflineData(ownerId);
      await refresh();
      await queryClient.invalidateQueries();
      if (!complete) setError(syncFailureMessage(getCloudSyncState(ownerId)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Rejected records could not be retried.');
    } finally { setBusy(false); }
  };

  const inspectAccountConflict = async () => {
    setBusy(true); setError(null); setAccountReconciliation(null);
    try {
      const local = await localDb.syncOutbox.rejectedAccountCreateForReconciliation(ownerId);
      if (!local) throw new Error('No eligible Wallet Cash account conflict was found; no data was changed.');
      const response = await cloudFetch(ownerId, '/api/v1/sync/reconcile-account-create', {
        method: 'POST',
        body: JSON.stringify({ entityId: local.entityId, mutationId: local.mutationId, payload: local.payload, currentBalanceMinor: local.local.currentBalanceMinor, commit: false }),
      });
      if (!response.ok) {
        let code: string | null = null;
        try {
          const body = await response.json() as { error?: { code?: unknown } };
          if (typeof body.error?.code === 'string') code = body.error.code;
        } catch { /* Keep the message generic if Neon did not return JSON. */ }
        if (response.status === 401 || response.status === 403) throw new Error('Cloud identity could not be verified. The account conflict was left unchanged.');
        if (response.status === 404 || code === 'CLOUD_RPC_SIGNATURE_MISSING' || code === 'CLOUD_FUNCTION_MISSING') {
          throw new Error('Neon does not have the account-reconciliation function installed or exposed yet. Apply the reviewed reconciliation migration and refresh the Data API schema cache; no account or balance was changed.');
        }
        throw new Error('The cloud account could not be checked. The conflict was left unchanged.');
      }
      const preview = await response.json() as CloudAccountReconciliationPreview;
      const assessment = assessAccountReconciliation(local, preview);
      setAccountReconciliation({ local, preview, reasons: assessment.reasons });
      if (!assessment.eligible) setError('The local and cloud records could not be fully matched. No data was changed.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The cloud account could not be checked. No data was changed.');
    } finally { setBusy(false); }
  };

  const reconcileAccountConflict = async () => {
    if (!accountReconciliation || accountReconciliation.reasons.length) return;
    setBusy(true); setError(null);
    try {
      const current = await localDb.syncOutbox.rejectedAccountCreateForReconciliation(ownerId);
      if (!current || current.mutationId !== accountReconciliation.local.mutationId || current.entityId !== accountReconciliation.local.entityId) {
        throw new Error('The local conflict changed after comparison. No data was changed; compare it again.');
      }
      const response = await cloudFetch(ownerId, '/api/v1/sync/reconcile-account-create', {
        method: 'POST',
        body: JSON.stringify({ entityId: current.entityId, mutationId: current.mutationId, payload: current.payload, currentBalanceMinor: current.local.currentBalanceMinor, commit: true }),
      });
      const result = await response.json() as { status?: string; ack?: Record<string, unknown>; reason?: string | null };
      if (!response.ok || result.status !== 'reconciled' || !result.ack || typeof result.ack !== 'object') {
        throw new Error(result.reason || 'The cloud did not confirm a safe reconciliation. The local record remains unchanged.');
      }
      await localDb.syncOutbox.acknowledge({ ownerId, cloudUserId: current.cloudUserId, mutationId: current.mutationId, response: result.ack });
      setAccountReconciliation(null);
      const complete = await syncOfflineData(ownerId);
      await refresh();
      await queryClient.invalidateQueries();
      if (!complete) setError('Wallet Cash was reconciled and confirmed. Other cloud changes still need attention.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The Wallet Cash conflict could not be reconciled. The local record remains safe.');
    } finally { setBusy(false); }
  };

  const disconnectSession = async () => {
    setBusy(true); setError(null);
    try { await getCloudAuthClient(ownerId).signOut(); setError('Cloud session signed out. The local profile and pending records remain on this device.'); }
    catch { setError('The local app remains available, but the cloud session could not be revoked. Try again when online.'); }
    finally { setBusy(false); }
  };

  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
    <View className="flex-1 justify-end bg-black/40">
      <View className="max-h-[90%] rounded-t-3xl bg-white dark:bg-neutral-900">
      <KeyboardAwareScrollView fitContent className="px-5 pt-5" contentContainerStyle={{ paddingBottom: 28 }} keyboardShouldPersistTaps="handled">
        <View className="mb-4 flex-row items-center justify-between"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Cloud sync</Text><Pressable accessibilityRole="button" onPress={onClose}><Text className="font-body text-sm font-semibold text-primary">Close</Text></Pressable></View>
        {identity ? <>
          <Text className="font-body text-sm text-gray-800 dark:text-neutral-100">Cloud identity connected</Text>
          <Text className="font-body mt-2 text-xs leading-5 text-gray-500 dark:text-neutral-400">Status: {syncState === 'action_required' ? 'sync failed' : syncState.replaceAll('_',' ')} · {pending} waiting · {rejected} failed</Text>
          <Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Last successful sync: {lastSuccessfulAt ? new Date(lastSuccessfulAt).toLocaleString() : 'Not yet synced'}</Text>
          {showSessionHelp ? <View className="mt-3 border border-amber-300 p-3 dark:border-amber-800">
            <Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">Cloud session needs attention</Text>
            <Text className="font-body mt-1 text-xs leading-5 text-gray-600 dark:text-neutral-300">Leverage refreshes the saved cloud token automatically when syncing. If Neon has ended the session, sign out and back in from the main sign-in screen. This panel will not ask for your password.</Text>
          </View> : null}
          <Text className="font-body mt-2 text-xs leading-5 text-gray-500 dark:text-neutral-400">Changes that failed to upload appear first with the reason. Waiting changes have not been confirmed by the cloud yet. Every item remains saved on this device.</Text>
          {rejected ? <View className="mt-3 border border-amber-300 p-3 dark:border-amber-800">
            <Text className="font-body text-xs font-semibold text-amber-800 dark:text-amber-200">These changes did not sync. Their local records are safe; each item below explains what stopped it.</Text>
            {queueItems.filter((item) => item.status === 'rejected').map((item) => {
              const display = projectSyncQueueRow(item);
              return <View key={item.mutationId} className="mt-3 border-t border-amber-200 pt-3 dark:border-amber-900">
                <Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">{display.title}</Text>
                <Text className="font-body mt-1 text-xs leading-5 text-gray-600 dark:text-neutral-300">{display.detail}</Text>
                <Text className="font-body mt-1 text-xs leading-5 text-amber-800 dark:text-amber-200">Why it did not sync: {display.reason}</Text>
                {display.errorCode ? <Text className="font-body mt-1 text-[11px] text-gray-500 dark:text-neutral-400">Diagnostic code: {display.errorCode}</Text> : null}
                <Text className="font-body mt-1 text-[11px] text-gray-500 dark:text-neutral-400">Saved {display.timestamp}</Text>
              </View>;
            })}
            {rejected > queueItems.filter((item) => item.status === 'rejected').length ? <Text className="font-body mt-2 text-xs text-amber-800 dark:text-amber-200">And {rejected - queueItems.filter((item) => item.status === 'rejected').length} more rejected changes.</Text> : null}
            {queueItems.some((item) => item.status === 'rejected' && item.entityType === 'account' && item.operation === 'account.create' && item.errorCategory === 'CLOUD_RECORD_ALREADY_EXISTS') ? <View className="mt-3 border-t border-amber-200 pt-3 dark:border-amber-900">
              <Text className="font-body text-xs leading-5 text-gray-700 dark:text-neutral-200">Compare Wallet Cash with the signed-in cloud account. Reconciliation is offered only if ownership, the original account record, opening balance, transaction history and current balance all match.</Text>
              <Pressable accessibilityRole="button" disabled={busy || syncState === 'syncing'} onPress={() => void inspectAccountConflict()} className="mt-3 min-h-11 items-center justify-center border border-primary px-4">
                {busy && !accountReconciliation ? <ActivityIndicator color={PRIMARY_COLOR} /> : <Text className="font-body font-semibold" style={{ color: PRIMARY_COLOR }}>Compare Wallet Cash</Text>}
              </Pressable>
              {accountReconciliation ? <View className="mt-3 border border-gray-200 p-3 dark:border-neutral-700">
                <Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">Cloud comparison</Text>
                <Text className="font-body mt-2 text-xs leading-5 text-gray-700 dark:text-neutral-200">Device: {accountReconciliation.local.local.name} · {accountReconciliation.local.local.type} · opening {displayMinor(accountReconciliation.local.local.openingBalanceMinor, accountReconciliation.local.local.currency)} · current {displayMinor(accountReconciliation.local.local.currentBalanceMinor, accountReconciliation.local.local.currency)}</Text>
                {accountReconciliation.preview.account ? <Text className="font-body mt-1 text-xs leading-5 text-gray-700 dark:text-neutral-200">Cloud: {accountReconciliation.preview.account.name} · {accountReconciliation.preview.account.type} · opening {displayMinor(accountReconciliation.preview.account.openingBalanceMinor, accountReconciliation.preview.account.currency)} · current {displayMinor(accountReconciliation.preview.account.currentBalanceMinor, accountReconciliation.preview.account.currency)}</Text> : <Text className="font-body mt-1 text-xs text-amber-800 dark:text-amber-200">No matching account is visible to this signed-in cloud profile.</Text>}
                <Text className="font-body mt-2 text-xs leading-5 text-gray-600 dark:text-neutral-300">Owner: {accountReconciliation.preview.evidence.ownerMatches ? 'matches signed-in profile' : 'does not match'} · Creation history: {accountReconciliation.preview.evidence.creationRecordCount} record(s), {accountReconciliation.preview.evidence.creationRecordMatches ? 'matches' : 'does not match'} · Receipt: {accountReconciliation.preview.evidence.receiptStatus}. Opening balance is stored on the account; no separate opening-balance transaction is posted.</Text>
                {accountReconciliation.reasons.length ? <Text className="font-body mt-2 text-xs leading-5 text-amber-800 dark:text-amber-200">Not safe to reconcile: {accountReconciliation.reasons.join(' ')}</Text> : <Text className="font-body mt-2 text-xs leading-5 text-green-700 dark:text-green-300">All account and balance checks match. The server can record the original mutation acknowledgment without creating another account or transaction.</Text>}
                {accountReconciliation.reasons.length === 0 ? <Pressable accessibilityRole="button" disabled={busy || syncState === 'syncing'} onPress={() => void reconcileAccountConflict()} className="mt-3 min-h-11 items-center justify-center bg-primary px-4">
                  {busy ? <ActivityIndicator color="#fff" /> : <Text className="font-body font-semibold text-white">Confirm safe reconciliation</Text>}
                </Pressable> : null}
              </View> : null}
            </View> : null}
            <Text className="font-body mt-2 text-xs leading-5 text-amber-800 dark:text-amber-200">Only temporary or session failures are retried. Duplicate IDs, conflicting records, and invalid details are held so they cannot create a second financial entry.</Text>
            <Pressable accessibilityRole="button" disabled={busy || syncState === 'syncing'} onPress={() => void retryRejected()} className="mt-3 min-h-11 items-center justify-center border border-amber-500 px-4">
              {busy ? <ActivityIndicator color={PRIMARY_COLOR} /> : <Text className="font-body font-semibold text-amber-800 dark:text-amber-200">Retry failed changes</Text>}
            </Pressable>
          </View> : null}
          {pending ? <View className="mt-4">
            <Text className="font-heading text-sm font-bold text-gray-900 dark:text-white">Waiting to reach the cloud</Text>
            {queueItems.filter((item) => item.status !== 'rejected').map((item) => {
              const display = projectSyncQueueRow(item);
              return <View key={item.mutationId} className="mt-2 border border-gray-200 p-3 dark:border-neutral-700">
                <View className="flex-row items-start justify-between gap-3"><Text className="font-body flex-1 text-sm font-semibold text-gray-900 dark:text-white">{display.title}</Text><Text className="font-body text-[11px] font-semibold text-primary">{display.state}</Text></View>
                <Text className="font-body mt-1 text-xs leading-5 text-gray-600 dark:text-neutral-300">{display.detail}</Text>
                <Text className="font-body mt-1 text-[11px] text-gray-500 dark:text-neutral-400">Saved {display.timestamp}</Text>
              </View>;
            })}
            {pending > queueItems.filter((item) => item.status !== 'rejected').length ? <Text className="font-body mt-2 text-xs text-gray-500 dark:text-neutral-400">And {pending - queueItems.filter((item) => item.status !== 'rejected').length} more waiting changes.</Text> : null}
          </View> : null}
          <Pressable disabled={busy || syncState === 'syncing'} onPress={() => void syncNow()} className="mt-5 min-h-12 items-center justify-center bg-primary px-4">{busy || syncState === 'syncing' ? <ActivityIndicator color="#fff" /> : <Text className="font-body font-semibold text-white">Sync now</Text>}</Pressable>
          <Pressable disabled={busy} onPress={() => void disconnectSession()} className="mt-2 min-h-11 items-center justify-center border border-primary px-4"><Text className="font-body font-semibold" style={{ color: PRIMARY_COLOR }}>Sign out of cloud</Text></Pressable>
        </> : <>
          <Text className="font-body mb-4 text-xs leading-5 text-gray-500 dark:text-neutral-400">Link this profile to your cloud account. Existing supported records will be queued, and new changes will sync after they are saved here. Keep using this device until the status confirms they have synced.</Text>
          <Input label="Cloud account email" placeholder="you@example.com" autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} />
          <Input label="Cloud account password" placeholder="Enter your cloud password" autoComplete="password" secureTextEntry value={password} onChangeText={setPassword} />
          {error ? <Text accessibilityRole="alert" className="font-body mt-2 text-xs leading-5 text-red-600">{error}</Text> : null}
          <Pressable disabled={busy} onPress={() => void connect(false)} className="mt-4 min-h-12 items-center justify-center bg-primary px-4">{busy ? <ActivityIndicator color="#fff" /> : <Text className="font-body font-semibold text-white">Sign in and connect</Text>}</Pressable>
          <Pressable disabled={busy} onPress={() => void connect(true)} className="mt-2 min-h-11 items-center justify-center border border-primary px-4"><Text className="font-body font-semibold" style={{ color: PRIMARY_COLOR }}>Create cloud account and connect</Text></Pressable>
        </>}
        {error && identity ? <Text accessibilityRole="alert" className="font-body mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">{error}</Text> : null}
      </KeyboardAwareScrollView>
      </View>
    </View>
  </Modal>;
}
