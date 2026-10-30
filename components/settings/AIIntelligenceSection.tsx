import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, Switch, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Brain, Eye, EyeOff, KeyRound, ShieldCheck, X } from 'lucide-react-native';
import { Button } from '../ui/Button';
import { KeyboardAwareScrollView } from '../ui/KeyboardAwareScrollView';
import { useAuth } from '../../src/context/AuthContext';
import { aiProfileStore } from '../../src/ai/profileStore';
import { AIGatewayError, aiGatewayClient, type RemoteAISettings } from '../../src/ai/gatewayClient';
import { DEFAULT_AI_PROFILE_CONFIG, invalidateAIConnection, OPENAI_MODELS, type AIProfileConfig, type AIReadScope } from '../../src/ai/config';
import { cancelAIProfileWork } from '../../src/ai/runtime';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';

const SCOPE_COPY: Record<AIReadScope, { title: string; description: string }> = {
  aggregatedFinancialInsights: { title: 'Aggregated Financial Insights', description: 'Calculated totals, budgets, savings progress, cash flow and ratios. Recommended first permission.' },
  detailedFinancialRecords: { title: 'Detailed Financial Records', description: 'Selected transaction details. Notes and account identifiers are excluded by default.' },
  projectsIntelligence: { title: 'Projects Intelligence', description: 'Project budgets, expenses and allocations the active profile is allowed to view.' },
};

function statusCopy(config: AIProfileConfig, hasCredential: boolean): string {
  if (!hasCredential || !config.provider) return 'Not configured';
  switch (config.connectionStatus) {
    case 'disabled': return 'Disabled';
    case 'not_configured': return 'Not configured';
    case 'validating': return 'Validating connection…';
    case 'connected': return config.enabled ? 'Connected and enabled' : 'Connected · disabled';
    case 'invalid_credentials': return 'Invalid credentials';
    case 'model_access_problem': return 'Model access needs attention';
    case 'rate_limited': return 'Rate limited · retry later';
    case 'quota_exhausted': return 'Provider quota exhausted';
    case 'temporarily_unavailable': return 'Provider temporarily unavailable';
    case 'reconfiguration_required': return 'Secure connection setup required';
  }
}

export function AIIntelligenceSection() {
  const { user } = useAuth();
  const profileId = user?.id ?? null;
  const nativeAvailable = Platform.OS !== 'web';
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [config, setConfig] = useState<AIProfileConfig>({ ...DEFAULT_AI_PROFILE_CONFIG, permissions: { ...DEFAULT_AI_PROFILE_CONFIG.permissions } });
  const [hasCredential, setHasCredential] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState('');
  const [showCredential, setShowCredential] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheetContentHeight, setSheetContentHeight] = useState(0);
  const [remoteSettings, setRemoteSettings] = useState<RemoteAISettings | null>(null);
  const loadSequence = useRef(0);
  const testController = useRef<AbortController | null>(null);

  const refresh = useCallback(async (currentProfileId: string) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const saved = await aiProfileStore.load(currentProfileId);
      let remote: RemoteAISettings | null = null;
      let gatewayNotice: string | null = null;
      if (aiGatewayClient.configured) {
        try { remote = await aiGatewayClient.getSettings(currentProfileId); }
        catch (error) { gatewayNotice = error instanceof Error ? error.message : 'Secure AI settings could not be reached.'; }
      }
      if (sequence === loadSequence.current) {
        setRemoteSettings(remote);
        setConfig(remote ? {
          ...saved,
          model: remote.model,
          enabled: remote.enabled && remote.hasCredential,
          permissions: remote.permissions,
          consentAcceptedAt: remote.consentAcceptedAt,
          credentialForwardingAcceptedAt: remote.credentialForwardingConsentAcceptedAt,
          connectionStatus: remote.connectionStatus,
          lastValidatedAt: remote.lastValidatedAt,
          maxMonthlyRequests: remote.monthlyRequestLimit,
        } : { ...saved, enabled: false });
        setHasCredential(remote?.hasCredential ?? false);
        setNotice(gatewayNotice);
      }
    } catch (error) {
      if (sequence === loadSequence.current) {
        setConfig({ ...DEFAULT_AI_PROFILE_CONFIG, connectionStatus: 'reconfiguration_required', permissions: { ...DEFAULT_AI_PROFILE_CONFIG.permissions } });
        setHasCredential(false);
        setNotice(error instanceof Error ? error.message : 'AI settings could not be loaded securely.');
      }
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, []);

  useEffect(() => {
    const sequence = ++loadSequence.current;
    const refreshTask = profileId ? setTimeout(() => { void refresh(profileId); }, 0) : null;
    return () => {
      if (refreshTask) clearTimeout(refreshTask);
      testController.current?.abort(new Error('AI settings closed or profile changed.'));
      testController.current = null;
      if (loadSequence.current >= sequence) loadSequence.current += 1;
    };
  }, [profileId, refresh]);

  const status = useMemo(() => statusCopy(config, hasCredential), [config, hasCredential]);
  const sheetHeight = Math.min(windowHeight * 0.92, Math.max(320, sheetContentHeight + 112 + insets.bottom));

  const save = useCallback(async (next: AIProfileConfig, syncRemote = true) => {
    if (!profileId) throw new Error('Unlock the active profile to change AI settings.');
    if (syncRemote && aiGatewayClient.configured) {
      const remote = await aiGatewayClient.updateSettings(profileId, {
        model: next.model,
        enabled: next.enabled,
        permissions: next.permissions,
        dataConsentAccepted: Boolean(next.consentAcceptedAt),
        credentialForwardingConsentAccepted: Boolean(next.credentialForwardingAcceptedAt),
        monthlyRequestLimit: next.maxMonthlyRequests,
      });
      setRemoteSettings(remote);
      setHasCredential(remote.hasCredential);
      next = { ...next, enabled: remote.enabled, connectionStatus: remote.connectionStatus, lastValidatedAt: remote.lastValidatedAt };
    }
    await aiProfileStore.save(profileId, next);
    setConfig(next);
  }, [profileId]);

  const toggleAI = async (enabled: boolean) => {
    setNotice(null);
    if (!enabled) {
      if (profileId) cancelAIProfileWork(profileId);
      testController.current?.abort(new Error('AI was disabled.'));
      const next = { ...config, enabled: false, revision: config.revision + 1 };
      await save(next, false);
      if (aiGatewayClient.configured && profileId) {
        try { await save(next, true); }
        catch { setNotice('AI was disabled on this device immediately. The gateway could not be reached to sync the disabled state.'); }
      }
      return;
    }
    const credentialAvailable = remoteSettings?.hasCredential ?? false;
    if (!aiGatewayClient.configured || !credentialAvailable || config.connectionStatus !== 'connected' || !config.lastValidatedAt || !config.consentAcceptedAt || !config.credentialForwardingAcceptedAt || !config.permissions.aggregatedFinancialInsights) {
      setVisible(true);
      setNotice('AI cannot be enabled until a secure authenticated provider gateway is configured and the selected model passes a real connection test.');
      return;
    }
    await save({ ...config, enabled: true, revision: config.revision + 1 });
  };

  const chooseModel = async (model: AIProfileConfig['model']) => {
    if (model === config.model) return;
    await save(invalidateAIConnection({ ...config, provider: 'openai', model }, 'reconfiguration_required'));
  };

  const changeScope = async (scope: AIReadScope, allowed: boolean) => {
    const permissions = { ...config.permissions, [scope]: allowed };
    if (config.enabled) {
      if (profileId) cancelAIProfileWork(profileId);
    }
    const next = {
      ...config,
      enabled: false,
      permissions,
      consentAcceptedAt: null,
      connectionStatus: config.connectionStatus,
      revision: config.revision + 1,
    };
    await save(next, false);
    if (aiGatewayClient.configured && profileId) {
      try { await save(next, true); }
      catch { setNotice('The permission was revoked on this device immediately. The gateway could not be reached to sync the change.'); }
    }
  };

  const saveCredential = async () => {
    if (!profileId) return;
    const key = credentialDraft.trim();
    if (!key) { setNotice('Enter the API key you created for your OpenAI project.'); return; }
    if (!aiGatewayClient.configured) { setNotice('The secure AI gateway is unavailable. The API key was not saved.'); return; }
    if (!config.credentialForwardingAcceptedAt) { setNotice('Accept the credential storage and forwarding disclosure before saving this key.'); return; }
    setBusy(true); setNotice(null);
    try {
      if (config.enabled) cancelAIProfileWork(profileId);
      const next = invalidateAIConnection({ ...config, enabled: false, provider: 'openai', lastValidatedAt: null }, 'reconfiguration_required');
      await save(next, true);
      const remote = await aiGatewayClient.saveCredential(profileId, key);
      setCredentialDraft('');
      setHasCredential(remote.hasCredential);
      setRemoteSettings(remote);
      setConfig({ ...next, connectionStatus: remote.connectionStatus, lastValidatedAt: remote.lastValidatedAt });
      setNotice('Credential encrypted and saved to your account. The key is never returned to this device; test the selected model to continue.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The credential could not be saved securely.');
    } finally { setBusy(false); }
  };

  const removeCredential = async () => {
    if (!profileId) return;
    setBusy(true); setNotice(null);
    cancelAIProfileWork(profileId);
    testController.current?.abort(new Error('Credential removed.'));
    try {
      if (!aiGatewayClient.configured) throw new Error('The secure gateway is unavailable. The cloud credential was not changed.');
      const remote = await aiGatewayClient.removeCredential(profileId);
      await save({ ...DEFAULT_AI_PROFILE_CONFIG, permissions: { ...DEFAULT_AI_PROFILE_CONFIG.permissions }, revision: config.revision + 1 }, false);
      setHasCredential(false);
      setCredentialDraft('');
      setRemoteSettings(remote);
      setNotice('The encrypted credential was removed from your account.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The credential could not be removed.');
    } finally { setBusy(false); }
  };

  const acceptConsent = async (accepted: boolean) => {
    await save({ ...config, enabled: false, consentAcceptedAt: accepted ? new Date().toISOString() : null, revision: config.revision + 1 });
  };

  const acceptCredentialForwarding = async (accepted: boolean) => {
    await save({ ...config, enabled: false, credentialForwardingAcceptedAt: accepted ? new Date().toISOString() : null, revision: config.revision + 1 });
    if (!accepted) setHasCredential(false);
  };

  const testConnection = async () => {
    if (!profileId || !aiGatewayClient.configured) {
      setNotice('This build has no configured secure AI gateway. No provider request was made.');
      return;
    }
    if (!config.credentialForwardingAcceptedAt) {
      setNotice('Review and accept the credential forwarding disclosure before testing.');
      return;
    }
    setBusy(true); setNotice(null);
    const controller = new AbortController();
    testController.current = controller;
    try {
      await save({ ...config, enabled: false, connectionStatus: 'validating', revision: config.revision + 1 }, false);
      const result = await aiGatewayClient.testConnection(profileId, config.model, controller.signal);
      const validatedAt = result.validatedAt;
      const next = { ...config, enabled: false, provider: 'openai' as const, connectionStatus: 'connected' as const, lastValidatedAt: validatedAt, revision: config.revision + 1 };
      setRemoteSettings(result);
      await aiProfileStore.save(profileId, next);
      setConfig(next);
      setNotice(`Connection verified for ${config.model}. You can now grant the required data permission and enable AI.`);
    } catch (error) {
      const code = error instanceof AIGatewayError ? error.code : '';
      const nextStatus: AIProfileConfig['connectionStatus'] = code === 'INVALID_OPENAI_CREDENTIAL' ? 'invalid_credentials'
        : code === 'OPENAI_MODEL_ACCESS' || code === 'OPENAI_MODEL_TEST_FAILED' ? 'model_access_problem'
          : code === 'OPENAI_RATE_LIMITED' || code === 'AI_MONTHLY_LIMIT_REACHED' ? 'rate_limited'
        : code === 'OPENAI_QUOTA_EXHAUSTED' ? 'quota_exhausted'
              : code.startsWith('AI_PROVIDER_') || code === 'AI_GATEWAY_UNAVAILABLE' || code === 'AI_GATEWAY_TIMEOUT' || code === 'OPENAI_INVALID_RESPONSE' ? 'temporarily_unavailable'
                : code === 'OPENAI_INSUFFICIENT_PERMISSION' ? 'model_access_problem'
                : 'reconfiguration_required';
      const next = { ...config, enabled: false, connectionStatus: nextStatus, lastValidatedAt: null, revision: config.revision + 1 };
      await aiProfileStore.save(profileId, next).catch(() => undefined);
      setConfig(next);
      setNotice(error instanceof AIGatewayError ? error.message : 'The connection test failed. AI remains disabled.');
    } finally { if (testController.current === controller) testController.current = null; setBusy(false); }
  };

  return (
    <>
      <View className="mb-4 rounded-md bg-white px-4 dark:bg-neutral-900">
        <Text className="font-body pb-2 pt-4 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-neutral-400">AI Intelligence</Text>
        <View className="min-h-[58px] flex-row items-center justify-between border-b border-gray-100 dark:border-neutral-800">
          <View className="flex-row items-center"><View className="mr-3 h-9 w-9 items-center justify-center rounded-full bg-primary/10"><Brain size={18} color={PRIMARY_COLOR} /></View><Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">Enable AI Intelligence</Text></View>
          {profileId && loading ? <ActivityIndicator color={PRIMARY_COLOR} /> : <Switch accessibilityLabel="Enable AI Intelligence" accessibilityState={{ checked: config.enabled, disabled: busy || !profileId || !nativeAvailable }} value={config.enabled} disabled={busy || !profileId || !nativeAvailable} onValueChange={(value) => { void toggleAI(value).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'AI settings could not be saved.')); }} trackColor={{ false: '#d1d5db', true: PRIMARY_COLOR }} thumbColor="#ffffff" />}
        </View>
        <Pressable accessibilityRole="button" onPress={() => { setNotice(null); setVisible(true); }} className="min-h-[56px] flex-row items-center justify-between border-b border-gray-100 dark:border-neutral-800">
          <View className="flex-row items-center"><View className="mr-3 h-9 w-9 items-center justify-center rounded-full bg-primary/10"><KeyRound size={18} color={PRIMARY_COLOR} /></View><Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">Provider configuration</Text></View>
          <Text className="font-body max-w-[145px] text-right text-xs text-gray-500 dark:text-neutral-400">{profileId && loading ? 'Loading…' : status}</Text>
        </Pressable>
        <Text className="font-body pb-4 pt-3 text-xs leading-5 text-gray-500 dark:text-neutral-400">AI is optional. It can only analyze information you allow. A secure provider gateway is required before credentials or financial data can be sent. Your normal financial features work without AI.</Text>
      </View>

      <Modal visible={visible} transparent animationType="slide" onRequestClose={() => setVisible(false)}>
        <View className="flex-1 justify-end bg-black/50">
          <SafeAreaView edges={['bottom']} className="w-full rounded-t-3xl bg-gray-50 px-5 pt-4 dark:bg-neutral-950" style={{ height: sheetHeight, maxHeight: windowHeight * 0.92, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
            <View className="mb-3 flex-row items-center justify-between">
              <View className="flex-row items-center"><ShieldCheck size={21} color={PRIMARY_COLOR} /><Text className="font-heading ml-2 text-xl font-bold text-gray-900 dark:text-white">AI Intelligence</Text></View>
              <Pressable accessibilityRole="button" accessibilityLabel="Close AI settings" onPress={() => setVisible(false)} className="min-h-11 min-w-11 items-center justify-center rounded-full bg-white dark:bg-neutral-800"><X size={20} color="#687386" /></Pressable>
            </View>
            <KeyboardAwareScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 20 }} onContentSizeChange={(_, contentHeight) => setSheetContentHeight(contentHeight)} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text className="font-body mb-3 text-sm leading-5 text-gray-600 dark:text-neutral-300">AI is optional. Any future analysis sends only selected information to the provider you choose. Ordinary financial records are never changed by AI.</Text>

              <Text className="font-body mb-2 text-sm font-semibold text-gray-900 dark:text-white">Provider</Text>
              <View className="mb-4 rounded-xl border border-gray-200 bg-white px-3 py-3 dark:border-neutral-700 dark:bg-neutral-900"><Text className="font-body font-semibold text-gray-900 dark:text-white">OpenAI</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">This phase sends only a synthetic connection test to the Responses API.</Text></View>

              <Text className="font-body mb-2 text-sm font-semibold text-gray-900 dark:text-white">Model</Text>
              <View className="mb-3 gap-2">{OPENAI_MODELS.map((model) => <Pressable key={model.id} accessibilityRole="radio" accessibilityState={{ checked: config.model === model.id, disabled: busy }} disabled={busy} onPress={() => void chooseModel(model.id).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Model selection could not be saved.'))} className={`min-h-11 flex-row items-center rounded-xl border px-3 py-2 ${config.model === model.id ? 'border-primary bg-primary/10' : 'border-gray-200 bg-white dark:border-neutral-700 dark:bg-neutral-900'}`}><View className={`mr-2 h-4 w-4 rounded-full border ${config.model === model.id ? 'border-primary bg-primary' : 'border-gray-400'}`} /><Text className="font-body flex-1 text-sm text-gray-800 dark:text-neutral-100">{model.label}</Text></Pressable>)}</View>

              <Text className="font-body mb-2 mt-2 text-sm font-semibold text-gray-900 dark:text-white">API credential</Text>
              {hasCredential ? <Text className="font-body mb-2 text-xs leading-5 text-gray-600 dark:text-neutral-300">An encrypted credential is saved to your account for use across your devices. Its value is never returned to the app.</Text> : <Text className="font-body mb-2 text-xs leading-5 text-gray-600 dark:text-neutral-300">Enter an OpenAI project key. The existing Leverage backend encrypts it before saving it to the account database; it is not stored on this device.</Text>}
              <View className="mb-2 min-h-12 flex-row items-center rounded-xl border border-gray-200 bg-white px-3 dark:border-neutral-700 dark:bg-neutral-900">
                <TextInput accessibilityLabel="OpenAI API key" value={credentialDraft} onChangeText={setCredentialDraft} secureTextEntry={!showCredential} autoCapitalize="none" autoCorrect={false} autoComplete="off" editable={!busy} placeholder={hasCredential ? 'Enter a replacement key' : 'Paste your OpenAI project key'} placeholderTextColor="#9ca3af" className="font-body min-h-12 flex-1 py-2 text-sm text-gray-900 dark:text-white" />
                <Pressable accessibilityRole="button" accessibilityLabel={showCredential ? 'Hide API key' : 'Show API key'} disabled={busy} onPress={() => setShowCredential((value) => !value)} className="min-h-10 min-w-10 items-center justify-center">{showCredential ? <EyeOff size={18} color="#737d8d" /> : <Eye size={18} color="#737d8d" />}</Pressable>
              </View>
              <Button title={busy ? 'Saving…' : hasCredential ? 'Replace credential' : 'Save encrypted credential'} onPress={() => void saveCredential()} disabled={busy || !credentialDraft.trim() || !config.credentialForwardingAcceptedAt || !aiGatewayClient.configured} isLoading={busy} />
              {hasCredential ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => void removeCredential()} className="mt-2 min-h-11 items-center justify-center"><Text className="font-body text-sm font-semibold text-red-600">Remove saved credential</Text></Pressable> : null}

              <View className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                <Text className="font-body text-sm font-semibold text-amber-900 dark:text-amber-100">Connection status: {statusCopy(config, hasCredential)}</Text>
                {config.lastValidatedAt ? <Text className="font-body mt-1 text-xs text-amber-800 dark:text-amber-200">Last successful validation: {new Date(config.lastValidatedAt).toLocaleString()}. A past check does not guarantee current access.</Text> : null}
                <Text className="font-body mt-1 text-xs leading-5 text-amber-800 dark:text-amber-200">{aiGatewayClient.configured ? 'The key is encrypted in your account database. It is decrypted only in the existing authenticated Leverage backend’s memory when a provider request runs, then forwarded over HTTPS. The key is never returned to the app.' : 'This build has no secure authenticated AI gateway. No key or financial data will be sent to OpenAI, and AI stays disabled.'}</Text>
              </View>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: Boolean(config.credentialForwardingAcceptedAt), disabled: busy }} disabled={busy} onPress={() => void acceptCredentialForwarding(!config.credentialForwardingAcceptedAt).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Consent could not be saved.'))} className="mb-3 mt-3 flex-row items-start rounded-xl bg-primary/5 p-3 dark:bg-primary/10"><View className={`mr-3 mt-0.5 h-5 w-5 items-center justify-center rounded border ${config.credentialForwardingAcceptedAt ? 'border-primary bg-primary' : 'border-gray-400 dark:border-neutral-500'}`}>{config.credentialForwardingAcceptedAt ? <Text className="font-body text-xs font-bold text-white">✓</Text> : null}</View><Text className="font-body flex-1 text-xs leading-5 text-gray-700 dark:text-neutral-200">I authorize Leverage’s existing backend to encrypt and store this key for my account, and decrypt it in memory only when forwarding my request to OpenAI over HTTPS. The key is never returned to the app or written to logs. OpenAI processes provider requests under its API terms.</Text></Pressable>
              <Button title={busy ? 'Testing connection…' : 'Test connection'} onPress={() => void testConnection()} disabled={busy || !hasCredential || !config.credentialForwardingAcceptedAt || !aiGatewayClient.configured} isLoading={busy} className="mt-1" />

              <Text className="font-body mb-2 mt-5 text-sm font-semibold text-gray-900 dark:text-white">Data permissions</Text>
              {(Object.keys(SCOPE_COPY) as AIReadScope[]).map((scope) => <View key={scope} className="mb-2 flex-row items-center justify-between rounded-xl border border-gray-200 bg-white px-3 py-3 dark:border-neutral-700 dark:bg-neutral-900"><View className="mr-3 flex-1"><Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">{SCOPE_COPY[scope].title}</Text><Text className="font-body mt-1 text-xs leading-4 text-gray-600 dark:text-neutral-300">{SCOPE_COPY[scope].description}</Text></View><Switch accessibilityLabel={`Allow ${SCOPE_COPY[scope].title}`} accessibilityState={{ checked: config.permissions[scope], disabled: busy }} value={config.permissions[scope]} disabled={busy} onValueChange={(value) => { void changeScope(scope, value).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Permission could not be saved.')); }} trackColor={{ false: '#d1d5db', true: PRIMARY_COLOR }} thumbColor="#ffffff" /></View>)}

              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: Boolean(config.consentAcceptedAt), disabled: busy }} disabled={busy} onPress={() => void acceptConsent(!config.consentAcceptedAt).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Consent could not be saved.'))} className="mb-3 mt-2 flex-row items-start rounded-xl bg-primary/5 p-3 dark:bg-primary/10"><View className={`mr-3 mt-0.5 h-5 w-5 items-center justify-center rounded border ${config.consentAcceptedAt ? 'border-primary bg-primary' : 'border-gray-400 dark:border-neutral-500'}`}>{config.consentAcceptedAt ? <Text className="font-body text-xs font-bold text-white">✓</Text> : null}</View><Text className="font-body flex-1 text-xs leading-5 text-gray-700 dark:text-neutral-200">I consent to sending only the information covered by my selected permissions to OpenAI when I request an AI analysis.</Text></Pressable>

              <Text className="font-body mb-2 mt-2 text-sm font-semibold text-gray-900 dark:text-white">Monthly request limit</Text>
              <View className="mb-2 flex-row gap-2">{([30, 60, 120] as const).map((limit) => <Pressable key={limit} accessibilityRole="radio" accessibilityState={{ checked: config.maxMonthlyRequests === limit, disabled: busy }} disabled={busy} onPress={() => void save({ ...config, enabled: false, maxMonthlyRequests: limit, revision: config.revision + 1 }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Usage limit could not be saved.'))} className={`min-h-10 flex-1 items-center justify-center rounded-xl border ${config.maxMonthlyRequests === limit ? 'border-primary bg-primary/10' : 'border-gray-200 bg-white dark:border-neutral-700 dark:bg-neutral-900'}`}><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{limit} / month</Text></Pressable>)}</View>
              <Text className="font-body mb-2 text-xs leading-5 text-gray-600 dark:text-neutral-300">{remoteSettings ? `${remoteSettings.monthlyRequestCount} of ${config.maxMonthlyRequests} connection-test requests used this month. The server enforces this limit.` : 'The gateway enforces this limit when configured. Provider billing limits should also be set in your OpenAI account.'}</Text>

              <Text className="font-body mb-2 text-sm font-semibold text-gray-900 dark:text-white">Usage and cost</Text>
              <Text className="font-body mb-2 text-xs leading-5 text-gray-600 dark:text-neutral-300">This phase counts connection tests; future AI requests must use the same gateway limit. OpenAI billing is separate, so set spending controls in your OpenAI project too.</Text>

              {notice ? <Text accessibilityRole="alert" className="font-body mb-2 mt-1 text-xs leading-5 text-amber-800 dark:text-amber-200">{notice}</Text> : null}
              <Text className="font-body mt-1 text-[11px] leading-4 text-gray-500 dark:text-neutral-400">No database write access is granted to AI. Suggested changes and financial actions are not available in this phase.</Text>
            </KeyboardAwareScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </>
  );
}
