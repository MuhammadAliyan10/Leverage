import React, { useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../src/context/AuthContext';
import { useAccounts } from '../hooks/queries/useAccounts';
import { useBudgetingWrites, useSavingsOverview } from '../hooks/queries/useBudgeting';
import { localDb } from '../src/db/local/client';
import { formatGroupedAmountInput, formatMinorUnits, formatMinorUnitsForInput, parseMinorUnits } from '../src/finance/ledger';
import { CURRENCIES, type CurrencyCode } from '../src/finance/domain';
import { Button } from '../components/ui/Button';
import { ActionSheet } from '../components/ui/ActionSheet';
import { DoneHeader } from '../components/ui/DoneHeader';
import { useAppConfirm } from '../components/ui/useAppConfirm';
import { BADGE_NEUTRAL, BADGE_NEUTRAL_TEXT, BADGE_PRIMARY, BADGE_PRIMARY_TEXT } from '../components/ui/badgeStyles';

const requestId = () => Crypto.randomUUID();
type EventMode = 'planned' | 'allocate' | 'release' | 'transfer_in' | 'transfer_out';
type SavingsDrawer = 'goal' | 'goal-event' | 'emergency-target' | 'emergency-event' | null;
const formatModeLabel = (mode: EventMode) => mode.split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
const isPositiveAmount = (value: string) => {
  try { return value.trim().length > 0 && parseMinorUnits(value) > 0; }
  catch { return false; }
};

export default function SavingsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { confirm, dialog } = useAppConfirm();
  const { data, isLoading, error, refetch } = useSavingsOverview();
  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data ?? [];
  const writes = useBudgetingWrites();
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [goalAmount, setGoalAmount] = useState('');
  const [emergencyAmount, setEmergencyAmount] = useState('');
  const [essentialValue, setEssentialValue] = useState<string | null>(null);
  const [monthsValue, setMonthsValue] = useState<string | null>(null);
  const [goalMode, setGoalMode] = useState<EventMode>('planned');
  const [emergencyMode, setEmergencyMode] = useState<EventMode>('allocate');
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null);
  const [goalAccountId, setGoalAccountId] = useState('');
  const [goalSourceId, setGoalSourceId] = useState('');
  const [goalDestinationId, setGoalDestinationId] = useState('');
  const [emergencyAccountId, setEmergencyAccountId] = useState('');
  const [emergencySourceId, setEmergencySourceId] = useState('');
  const [emergencyDestinationId, setEmergencyDestinationId] = useState('');
  const [goalCurrency, setGoalCurrency] = useState<CurrencyCode>('PKR');
  const [emergencyCurrencyValue, setEmergencyCurrencyValue] = useState<CurrencyCode | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<SavingsDrawer>(null);
  const [busy, setBusy] = useState(false);
  const operationInFlight = useRef(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackIsError, setFeedbackIsError] = useState(true);
  const emergencyCurrency = emergencyCurrencyValue ?? (data?.emergency?.currency as CurrencyCode | undefined) ?? 'PKR';
  const essential = essentialValue ?? (data?.emergency ? formatMinorUnitsForInput(data.emergency.essentialMonthlyMinor) : '');
  const months = monthsValue ?? String(data?.emergency?.coverageMonths ?? 3);
  const selectedGoalCurrency = data?.goals.find((goal) => goal.id === selectedGoal)?.currency ?? goalCurrency;
  const goalAccountOptions = accounts.filter((account) => account.currency === selectedGoalCurrency);
  const emergencyAccountOptions = accounts.filter((account) => account.currency === emergencyCurrency);
  const historyQuery = useQuery({
    queryKey: ['savings-history', user?.id, selectedGoal],
    enabled: !!user && !!selectedGoal,
    queryFn: async () => {
      if (!user || !selectedGoal) return [];
      return localDb.savings.history(user.id, selectedGoal);
    },
  });

  const run = async (task: () => Promise<unknown>, success?: () => void) => {
    // State updates are asynchronous; this synchronous lock prevents a fast double tap
    // from posting two separate, valid financial events before the screen rerenders.
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    setFeedback('');
    setFeedbackIsError(true);
    try { await task(); success?.(); }
    catch (e) { setFeedback(e instanceof Error ? e.message : 'Could not save. Please try again.'); }
    finally { operationInFlight.current = false; setBusy(false); }
  };
  const saveGoal = () => {
    if (!user) return;
    if (!name.trim()) { setFeedback('Enter a name for this savings goal.'); setFeedbackIsError(true); return; }
    if (name.trim().length > 100) { setFeedback('Goal names can be up to 100 characters.'); setFeedbackIsError(true); return; }
    if (!isPositiveAmount(target)) { setFeedback('Enter a valid target amount greater than zero.'); setFeedbackIsError(true); return; }
    void run(async () => writes.saveGoal.mutateAsync({ id: editingGoalId ?? requestId(), ownerId: user.id, name, targetMinor: parseMinorUnits(target), currency: goalCurrency, targetDate: null }), () => { setName(''); setTarget(''); setEditingGoalId(null); setActiveDrawer(null); setFeedback('Savings goal saved.'); setFeedbackIsError(false); });
  };
  const recordGoalEvent = () => {
    if (!user || !selectedGoal) { setFeedback('Select a savings goal before recording a contribution.'); setFeedbackIsError(true); return; }
    if (!isPositiveAmount(goalAmount)) { setFeedback('Enter a valid amount greater than zero.'); setFeedbackIsError(true); return; }
    if ((goalMode === 'allocate' || goalMode === 'release') && !goalAccountId) { setFeedback('Select the account for this savings activity.'); setFeedbackIsError(true); return; }
    if ((goalMode === 'transfer_in' || goalMode === 'transfer_out') && (!goalSourceId || !goalDestinationId || goalSourceId === goalDestinationId)) { setFeedback('Choose two different accounts for this transfer.'); setFeedbackIsError(true); return; }
    void run(() => writes.goalEvent.mutateAsync({ id: requestId(), ownerId: user.id, goalId: selectedGoal, eventType: goalMode, amountMinor: parseMinorUnits(goalAmount),
      eventDate: new Date().toISOString(), accountId: goalMode === 'allocate' || goalMode === 'release' ? goalAccountId : undefined,
      sourceAccountId: goalMode === 'transfer_in' || goalMode === 'transfer_out' ? goalSourceId : undefined,
      destinationAccountId: goalMode === 'transfer_in' || goalMode === 'transfer_out' ? goalDestinationId : undefined }), () => { setGoalAmount(''); setActiveDrawer(null); setFeedback('Goal activity recorded.'); setFeedbackIsError(false); });
  };
  const saveEmergency = () => {
    if (!user) return;
    if (!isPositiveAmount(essential)) { setFeedback('Enter valid essential monthly costs greater than zero.'); setFeedbackIsError(true); return; }
    if (!/^\d+$/.test(months) || Number(months) < 1 || Number(months) > 60) { setFeedback('Choose a whole number of coverage months from 1 to 60.'); setFeedbackIsError(true); return; }
    void run(() => writes.saveEmergencyConfig.mutateAsync({ ownerId: user.id, currency: emergencyCurrency, essentialMonthlyMinor: essential.trim() ? parseMinorUnits(essential) : 0, coverageMonths: Number(months) }), () => { setEssentialValue(null); setMonthsValue(null); setEmergencyCurrencyValue(null); setActiveDrawer(null); setFeedback('Emergency-fund target saved.'); setFeedbackIsError(false); });
  };
  const recordEmergency = () => {
    if (!user) return;
    if (!isPositiveAmount(emergencyAmount)) { setFeedback('Enter a valid amount greater than zero.'); setFeedbackIsError(true); return; }
    const transfer = emergencyMode === 'transfer_in' || emergencyMode === 'transfer_out';
    if (transfer ? (!emergencySourceId || !emergencyDestinationId) : !emergencyAccountId) { setFeedback('Select the account or both transfer accounts first.'); setFeedbackIsError(true); return; }
    if (transfer && emergencySourceId === emergencyDestinationId) { setFeedback('Choose two different accounts for this transfer.'); setFeedbackIsError(true); return; }
    void run(() => writes.emergencyEvent.mutateAsync({ id: requestId(), ownerId: user.id,
      eventType: emergencyMode === 'release' || emergencyMode === 'transfer_out' ? emergencyMode : emergencyMode === 'transfer_in' ? 'transfer_in' : 'allocate',
      amountMinor: parseMinorUnits(emergencyAmount), eventDate: new Date().toISOString(), accountId: transfer ? undefined : emergencyAccountId,
      sourceAccountId: transfer ? emergencySourceId : undefined, destinationAccountId: transfer ? emergencyDestinationId : undefined }), () => { setEmergencyAmount(''); setActiveDrawer(null); setFeedback('Emergency-fund activity recorded.'); setFeedbackIsError(false); });
  };
  const confirmArchiveGoal = async (goalId: string) => {
    const archive = () => void run(() => writes.goalStatus.mutateAsync({ goalId, status: 'archived' }), () => {
      if (selectedGoal === goalId) setSelectedGoal(null);
      setFeedback('Savings goal archived; its history is preserved.'); setFeedbackIsError(false);
    });
    if (await confirm({ title: 'Archive this goal?', message: 'Its contribution history will remain saved.', confirmLabel: 'Archive', destructive: true })) archive();
  };
  const closeSavings = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const drawerTitle = activeDrawer === 'goal'
    ? editingGoalId ? 'Edit savings goal' : 'Create savings goal'
    : activeDrawer === 'goal-event' ? 'Record goal activity'
      : activeDrawer === 'emergency-target' ? 'Emergency-fund target'
        : 'Record emergency-fund activity';
  const renderFeedback = () => feedback ? <View accessibilityRole={feedbackIsError ? 'alert' : 'text'} accessibilityLiveRegion="polite" className={`mb-3 rounded-md border p-3 ${feedbackIsError ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950' : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950'}`}><Text className={`font-body text-sm ${feedbackIsError ? 'text-red-700 dark:text-red-200' : 'text-emerald-700 dark:text-emerald-200'}`}>{feedback}</Text></View> : null;
  const currencyChoices = (selected: CurrencyCode, onSelect: (code: CurrencyCode) => void) => <View className="mt-1 flex-row flex-wrap">{(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => <Pressable key={code} accessibilityRole="radio" accessibilityState={{ checked: selected === code }} onPress={() => onSelect(code)} className={`mr-2 mt-2 rounded-full px-3 py-2 ${selected === code ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body text-xs ${selected === code ? `font-bold ${BADGE_PRIMARY_TEXT}` : BADGE_NEUTRAL_TEXT}`}>{code}</Text></Pressable>)}</View>;
  const accountChoices = (selected: string, onSelect: (id: string) => void, options: typeof accounts, label: string) => <View className="mt-3"><Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">{label}</Text><View className="mt-1 flex-row flex-wrap">{options.map((account) => <Pressable key={account.id} accessibilityRole="radio" accessibilityLabel={`${label}: ${account.name}`} accessibilityState={{ checked: selected === account.id }} onPress={() => onSelect(account.id)} className={`mr-2 mt-2 rounded-full border px-3 py-2 ${selected === account.id ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body text-xs ${selected === account.id ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>{account.name}</Text></Pressable>)}</View>{options.length === 0 ? <Text className="font-body mt-2 text-xs text-amber-700 dark:text-amber-300">No active account uses this currency.</Text> : null}</View>;

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <DoneHeader title="Savings & Safety Net" onDone={closeSavings} />
    <ScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{ paddingBottom: 24 }}>
      {!!error && <View className="mb-3 rounded-md bg-red-50 p-3 dark:bg-red-950"><Text className="font-body text-sm text-red-700 dark:text-red-200">Savings could not be loaded: {error.message}</Text><Pressable accessibilityRole="button" onPress={() => void refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable></View>}
      {renderFeedback()}
      {isLoading ? <Text className="font-body py-4 text-gray-500">Loading savings…</Text> : null}

      <View className="mb-3 flex-row items-center justify-between gap-3">
        <View className="flex-1"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Savings goals</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Track your targets and money set aside.</Text></View>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setEditingGoalId(null); setName(''); setTarget(''); setGoalCurrency('PKR'); setActiveDrawer('goal'); }} className="houselog-button px-3 py-2"><Text className="font-body text-sm font-semibold text-white">＋ Add goal</Text></Pressable>
      </View>

      {!isLoading && !error && data?.goals.length === 0 ? <View className="mb-3 rounded-md border border-dashed border-gray-300 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900"><Text className="font-body font-semibold text-gray-900 dark:text-white">Start with a savings goal</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Set a target, then record contributions as you save.</Text><Pressable accessibilityRole="button" onPress={() => setActiveDrawer('goal')} className="mt-3 self-start"><Text className="font-body font-semibold text-primary">Create your first goal →</Text></Pressable></View> : null}

      {data?.goals.map((goal) => <View key={goal.id} className="mb-3 rounded-md border border-gray-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <View className="flex-row items-start justify-between gap-2"><View className="flex-1"><Text className="font-body font-bold text-gray-900 dark:text-white">{goal.name}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{goal.currency} · {goal.status === 'active' ? 'In progress' : goal.status === 'completed' ? 'Completed' : 'Archived'}</Text></View><Text className={`font-body rounded-full px-2 py-1 text-xs capitalize ${BADGE_NEUTRAL} ${BADGE_NEUTRAL_TEXT}`}>{goal.status}</Text></View>
        <View className="mt-3 flex-row items-end justify-between gap-3"><View><Text className="font-heading text-xl font-bold text-gray-900 dark:text-white">{formatMinorUnits(goal.actualMinor, goal.currency)}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">set aside</Text></View><Text className="font-body text-right text-sm font-semibold text-gray-700 dark:text-neutral-200">of {formatMinorUnits(goal.targetMinor, goal.currency)}</Text></View>
        <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.min(100, goal.progress.percentComplete) }} className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800"><View className="h-2 rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, goal.progress.percentComplete))}%` }} /></View>
        <View className="mt-1 flex-row justify-between"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{goal.progress.percentComplete.toFixed(1)}% saved</Text>{goal.plannedMinor > 0 ? <Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Planned {formatMinorUnits(goal.plannedMinor, goal.currency)} · not yet saved</Text> : null}</View>
        <View className="mt-3 flex-row flex-wrap gap-2">
          {goal.status === 'active' ? <>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setSelectedGoal(goal.id); setGoalMode('allocate'); setGoalCurrency(goal.currency as CurrencyCode); setGoalAccountId(''); setGoalSourceId(''); setGoalDestinationId(''); setGoalAmount(''); setActiveDrawer('goal-event'); }} className="houselog-button px-3 py-2"><Text className="font-body text-xs font-semibold text-white">＋ Add activity</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setEditingGoalId(goal.id); setName(goal.name); setTarget(formatMinorUnitsForInput(goal.targetMinor)); setGoalCurrency(goal.currency as CurrencyCode); setActiveDrawer('goal'); }} className="rounded-md bg-gray-100 px-3 py-2 dark:bg-neutral-800"><Text className="font-body text-xs text-gray-700 dark:text-neutral-200">Edit</Text></Pressable>
          </> : null}
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => setSelectedGoal(selectedGoal === goal.id ? null : goal.id)} className="rounded-md bg-gray-100 px-3 py-2 dark:bg-neutral-800"><Text className="font-body text-xs text-gray-700 dark:text-neutral-200">{selectedGoal === goal.id ? 'Hide history' : 'History'}</Text></Pressable>
          {goal.status !== 'archived' ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => confirmArchiveGoal(goal.id)} className="rounded-md bg-gray-100 px-3 py-2 dark:bg-neutral-800"><Text className="font-body text-xs text-red-600 dark:text-red-300">Archive</Text></Pressable> : null}
          {goal.status === 'active' && goal.actualMinor >= goal.targetMinor ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(() => writes.goalStatus.mutateAsync({ goalId: goal.id, status: 'completed' }), () => { setFeedback('Savings goal marked complete.'); setFeedbackIsError(false); })} className="houselog-button px-3 py-2"><Text className="font-body text-xs text-white">Complete</Text></Pressable> : null}
        </View>
        {selectedGoal === goal.id ? <View className="mt-3 border-t border-gray-100 pt-3 dark:border-neutral-800">{historyQuery.isLoading ? <Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Loading history…</Text> : null}{historyQuery.error ? <View><Text className="font-body text-xs text-red-700 dark:text-red-300">History could not be loaded: {historyQuery.error.message}</Text><Pressable accessibilityRole="button" onPress={() => void historyQuery.refetch()} className="mt-2 self-start"><Text className="font-body text-xs font-semibold text-primary">Retry</Text></Pressable></View> : null}{historyQuery.data?.length === 0 && !historyQuery.isLoading ? <Text className="font-body text-xs text-gray-500 dark:text-neutral-400">No activity recorded yet.</Text> : null}{historyQuery.data?.map((event) => <Text key={event.id} className="font-body py-1 text-xs capitalize text-gray-600 dark:text-neutral-300">{new Date(event.eventDate).toLocaleDateString()} · {event.eventType.replace('_', ' ')} · {formatMinorUnits(event.amountMinor, event.currency)}{event.note ? ` · ${event.note}` : ''}</Text>)}</View> : null}
      </View>)}

      <View className="mb-3 mt-3 flex-row items-center justify-between gap-3"><View className="flex-1"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Emergency fund</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Plan a cash reserve for essential monthly costs.</Text></View><Text className={`font-body rounded-full px-2 py-1 text-xs ${BADGE_PRIMARY} ${BADGE_PRIMARY_TEXT}`}>{emergencyCurrency}</Text></View>
      <View className="rounded-md border border-primary/20 bg-primary/5 p-4 dark:bg-primary/10">
        {data?.emergency ? <>
          <View className="flex-row items-start justify-between gap-3"><View className="flex-1"><Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">Target</Text><Text className="font-heading mt-1 text-xl font-bold text-gray-900 dark:text-white">{formatMinorUnits(data.emergency.requiredMinor, data.emergency.currency)}</Text></View><View className="items-end"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Set aside</Text><Text className="font-body mt-1 text-base font-bold text-primary">{formatMinorUnits(data.emergency.allocatedMinor, data.emergency.currency)}</Text></View></View>
          <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: data.emergency.requiredMinor > 0 ? Math.min(100, (data.emergency.allocatedMinor / data.emergency.requiredMinor) * 100) : 0 }} className="mt-3 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-neutral-800"><View className="h-2 rounded-full bg-primary" style={{ width: `${data.emergency.requiredMinor > 0 ? Math.min(100, (data.emergency.allocatedMinor / data.emergency.requiredMinor) * 100) : 0}%` }} /></View>
          <Text className="font-body mt-2 text-xs text-gray-600 dark:text-neutral-300">Covers {data.emergency.coverageMonthsActual.toFixed(1)} of {data.emergency.coverageMonths} planned months · {formatMinorUnits(data.emergency.remainingMinor, data.emergency.currency)} left to target</Text>
        </> : <Text className="font-body text-sm text-gray-700 dark:text-neutral-200">No emergency target yet. Set essential monthly costs and choose how many months to cover.</Text>}
        <Text className="font-body mt-2 text-xs text-gray-500 dark:text-neutral-400">Set-aside emergency money remains part of the linked account balance.</Text>
        <View className="mt-3 flex-row flex-wrap gap-2"><Pressable accessibilityRole="button" disabled={busy} onPress={() => setActiveDrawer('emergency-target')} className="houselog-button px-3 py-2"><Text className="font-body text-xs font-semibold text-white">{data?.emergency ? 'Edit target' : 'Set target'}</Text></Pressable><Pressable accessibilityRole="button" disabled={busy} onPress={() => { setEmergencyAmount(''); setEmergencyMode('allocate'); setEmergencyAccountId(''); setEmergencySourceId(''); setEmergencyDestinationId(''); setActiveDrawer('emergency-event'); }} className="rounded-md bg-white px-3 py-2 dark:bg-neutral-800"><Text className="font-body text-xs font-semibold text-primary">＋ Record activity</Text></Pressable></View>
      </View>

      {!!accountsQuery.error && <View className="mt-4 rounded-md bg-red-50 p-3 dark:bg-red-950"><Text className="font-body text-sm text-red-700 dark:text-red-200">Accounts could not be loaded: {accountsQuery.error.message}</Text><Pressable accessibilityRole="button" onPress={() => void accountsQuery.refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable></View>}
      {accountsQuery.isLoading ? <Text className="font-body mt-4 text-gray-500">Loading accounts…</Text> : null}
      {accounts.length === 0 && !accountsQuery.isLoading && !accountsQuery.error ? <Pressable accessibilityRole="link" onPress={() => router.push('/accounts')} className="mt-4 rounded-md bg-amber-50 p-3 dark:bg-amber-950"><Text className="font-body text-sm text-amber-800 dark:text-amber-200">Create an account before setting aside or transferring savings. Open accounts →</Text></Pressable> : null}
    </ScrollView>

    <ActionSheet visible={activeDrawer !== null} title={drawerTitle} onClose={() => setActiveDrawer(null)} height={activeDrawer === 'goal-event' || activeDrawer === 'emergency-event' ? '90%' : '78%'}>
      {renderFeedback()}
      {activeDrawer === 'goal' ? <>
        <Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Currency</Text>{currencyChoices(goalCurrency, setGoalCurrency)}
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Goal name</Text><TextInput accessibilityLabel="Savings goal name" value={name} onChangeText={setName} placeholder="e.g. Home savings" maxLength={100} autoCapitalize="sentences" className="font-body mt-1 rounded-md bg-gray-100 px-3 py-3 text-gray-900 dark:bg-neutral-800 dark:text-white" />
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Target amount · {goalCurrency}</Text><TextInput accessibilityLabel={`Savings goal target amount in ${goalCurrency}`} value={target} onChangeText={(value) => setTarget(formatGroupedAmountInput(value))} placeholder={`e.g. 100,000 ${goalCurrency}`} keyboardType="decimal-pad" inputMode="decimal" className="font-body mt-1 rounded-md bg-gray-100 px-3 py-3 text-gray-900 dark:bg-neutral-800 dark:text-white" />
        <View className="mt-5"><Button title={editingGoalId ? 'Save goal' : 'Create savings goal'} onPress={saveGoal} isLoading={busy} /></View>
        {editingGoalId ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setEditingGoalId(null); setName(''); setTarget(''); setActiveDrawer(null); }} className="mt-3 items-center py-2"><Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Cancel editing</Text></Pressable> : null}
      </> : null}
      {activeDrawer === 'goal-event' ? <>
        <Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">{data?.goals.find((goal) => goal.id === selectedGoal)?.name ?? 'Savings goal'}</Text>
        <Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Plan records an intention. Set aside or release reserves existing money. A transfer changes account balances.</Text>
        <View className="mt-2 flex-row flex-wrap">{(['planned', 'allocate', 'release', 'transfer_in', 'transfer_out'] as EventMode[]).map((item) => <Pressable key={item} accessibilityRole="radio" accessibilityState={{ checked: goalMode === item }} onPress={() => setGoalMode(item)} className={`mr-2 mt-2 rounded-full px-3 py-2 ${goalMode === item ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body text-xs ${goalMode === item ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>{formatModeLabel(item)}</Text></Pressable>)}</View>
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Amount · {selectedGoalCurrency}</Text><TextInput accessibilityLabel={`Goal contribution amount in ${selectedGoalCurrency}`} value={goalAmount} onChangeText={(value) => setGoalAmount(formatGroupedAmountInput(value))} placeholder={`e.g. 10,000 ${selectedGoalCurrency}`} keyboardType="decimal-pad" inputMode="decimal" className="font-body mt-1 rounded-md bg-gray-100 px-3 py-3 text-gray-900 dark:bg-neutral-800 dark:text-white" />
        {(goalMode === 'allocate' || goalMode === 'release') ? accountChoices(goalAccountId, setGoalAccountId, goalAccountOptions, 'Account') : null}
        {(goalMode === 'transfer_in' || goalMode === 'transfer_out') ? <View className="mt-3"><Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Transfer accounts · {selectedGoalCurrency}</Text><View className="mt-1 flex-row flex-wrap">{goalAccountOptions.map((account) => <View key={account.id} className={`mr-2 mt-2 flex-row rounded-full ${BADGE_NEUTRAL}`}><Pressable accessibilityRole="radio" accessibilityState={{ checked: goalSourceId === account.id }} onPress={() => { setGoalSourceId(account.id); if (goalDestinationId === account.id) setGoalDestinationId(''); }} className={`rounded-full px-2 py-2 ${goalSourceId === account.id ? BADGE_PRIMARY : ''}`}><Text className={`font-body text-xs ${goalSourceId === account.id ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>From {account.name}</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ checked: goalDestinationId === account.id }} onPress={() => { setGoalDestinationId(account.id); if (goalSourceId === account.id) setGoalSourceId(''); }} className={`rounded-full px-2 py-2 ${goalDestinationId === account.id ? BADGE_PRIMARY : ''}`}><Text className={`font-body text-xs ${goalDestinationId === account.id ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>To {account.name}</Text></Pressable></View>)}</View>{goalAccountOptions.length < 2 ? <Text className="font-body mt-2 text-xs text-amber-700 dark:text-amber-300">A transfer needs two active accounts in this currency.</Text> : null}</View> : null}
        <View className="mt-5"><Button title={`Record ${formatModeLabel(goalMode).toLowerCase()}`} onPress={recordGoalEvent} isLoading={busy} /></View>
      </> : null}
      {activeDrawer === 'emergency-target' ? <>
        <Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Currency</Text>{currencyChoices(emergencyCurrency, (code) => setEmergencyCurrencyValue(code))}
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Essential monthly costs · {emergencyCurrency}</Text><TextInput accessibilityLabel={`Essential monthly costs in ${emergencyCurrency}`} value={essential} onChangeText={(value) => setEssentialValue(formatGroupedAmountInput(value))} placeholder="e.g. 50,000" keyboardType="decimal-pad" inputMode="decimal" className="font-body mt-1 rounded-md bg-gray-100 px-3 py-3 text-gray-900 dark:bg-neutral-800 dark:text-white" />
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Months to cover (1–60)</Text><TextInput accessibilityLabel="Emergency fund coverage months" value={months} onChangeText={setMonthsValue} placeholder="3" keyboardType="number-pad" inputMode="numeric" className="font-body mt-1 rounded-md bg-gray-100 px-3 py-3 text-gray-900 dark:bg-neutral-800 dark:text-white" />
        <View className="mt-5"><Button title="Save emergency target" onPress={saveEmergency} isLoading={busy} /></View>
      </> : null}
      {activeDrawer === 'emergency-event' ? <>
        <Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Set aside or release money in an account, or transfer between two accounts.</Text>
        <View className="mt-2 flex-row flex-wrap">{(['allocate', 'release', 'transfer_in', 'transfer_out'] as EventMode[]).map((item) => <Pressable key={item} accessibilityRole="radio" accessibilityState={{ checked: emergencyMode === item }} onPress={() => setEmergencyMode(item)} className={`mr-2 mt-2 rounded-full px-3 py-2 ${emergencyMode === item ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body text-xs ${emergencyMode === item ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>{formatModeLabel(item)}</Text></Pressable>)}</View>
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Amount · {emergencyCurrency}</Text><TextInput accessibilityLabel={`Emergency fund amount in ${emergencyCurrency}`} value={emergencyAmount} onChangeText={(value) => setEmergencyAmount(formatGroupedAmountInput(value))} placeholder={`Enter an amount in ${emergencyCurrency}`} keyboardType="decimal-pad" inputMode="decimal" className="font-body mt-1 rounded-md bg-gray-100 px-3 py-3 text-gray-900 dark:bg-neutral-800 dark:text-white" />
        {(emergencyMode === 'transfer_in' || emergencyMode === 'transfer_out') ? <View className="mt-3"><Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Transfer accounts · {emergencyCurrency}</Text><View className="mt-1 flex-row flex-wrap">{emergencyAccountOptions.map((account) => <View key={account.id} className={`mr-2 mt-2 flex-row rounded-full ${BADGE_NEUTRAL}`}><Pressable accessibilityRole="radio" accessibilityState={{ checked: emergencySourceId === account.id }} onPress={() => { setEmergencySourceId(account.id); if (emergencyDestinationId === account.id) setEmergencyDestinationId(''); }} className={`rounded-full px-2 py-2 ${emergencySourceId === account.id ? BADGE_PRIMARY : ''}`}><Text className={`font-body text-xs ${emergencySourceId === account.id ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>From {account.name}</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ checked: emergencyDestinationId === account.id }} onPress={() => { setEmergencyDestinationId(account.id); if (emergencySourceId === account.id) setEmergencySourceId(''); }} className={`rounded-full px-2 py-2 ${emergencyDestinationId === account.id ? BADGE_PRIMARY : ''}`}><Text className={`font-body text-xs ${emergencyDestinationId === account.id ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>To {account.name}</Text></Pressable></View>)}</View>{emergencyAccountOptions.length < 2 ? <Text className="font-body mt-2 text-xs text-amber-700 dark:text-amber-300">A transfer needs two active accounts in this currency.</Text> : null}</View> : accountChoices(emergencyAccountId, setEmergencyAccountId, emergencyAccountOptions, 'Choose an account')}
        <View className="mt-5"><Button title={`${formatModeLabel(emergencyMode)} emergency funds`} onPress={recordEmergency} isLoading={busy} /></View>
      </> : null}
    </ActionSheet>
    {dialog}
  </SafeAreaView>;
}
