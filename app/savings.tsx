import React, { useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../src/context/AuthContext';
import { useAccounts } from '../hooks/queries/useAccounts';
import { useBudgetingWrites, useSavingsOverview } from '../hooks/queries/useBudgeting';
import { localDb } from '../src/db/local/client';
import { formatMinorUnits, formatMinorUnitsForInput, parseMinorUnits } from '../src/finance/ledger';
import { CURRENCIES, type CurrencyCode } from '../src/finance/domain';
import { Button } from '../components/ui/Button';
import { DoneHeader } from '../components/ui/DoneHeader';

const requestId = () => `houselog-${Date.now()}-${Math.random().toString(36).slice(2)}`;
type EventMode = 'planned' | 'allocate' | 'release' | 'transfer_in' | 'transfer_out';
const formatModeLabel = (mode: EventMode) => mode.split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
const isPositiveAmount = (value: string) => {
  try { return value.trim().length > 0 && parseMinorUnits(value) > 0; }
  catch { return false; }
};

export default function SavingsScreen() {
  const router = useRouter();
  const { user } = useAuth();
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
    void run(async () => writes.saveGoal.mutateAsync({ id: editingGoalId ?? requestId(), ownerId: user.id, name, targetMinor: parseMinorUnits(target), currency: goalCurrency, targetDate: null }), () => { setName(''); setTarget(''); setEditingGoalId(null); setFeedback('Savings goal saved.'); setFeedbackIsError(false); });
  };
  const recordGoalEvent = () => {
    if (!user || !selectedGoal) { setFeedback('Select a savings goal before recording a contribution.'); setFeedbackIsError(true); return; }
    if (!isPositiveAmount(goalAmount)) { setFeedback('Enter a valid amount greater than zero.'); setFeedbackIsError(true); return; }
    if ((goalMode === 'allocate' || goalMode === 'release') && !goalAccountId) { setFeedback('Select the account for this savings activity.'); setFeedbackIsError(true); return; }
    if ((goalMode === 'transfer_in' || goalMode === 'transfer_out') && (!goalSourceId || !goalDestinationId || goalSourceId === goalDestinationId)) { setFeedback('Choose two different accounts for this transfer.'); setFeedbackIsError(true); return; }
    void run(() => writes.goalEvent.mutateAsync({ id: requestId(), ownerId: user.id, goalId: selectedGoal, eventType: goalMode, amountMinor: parseMinorUnits(goalAmount),
      eventDate: new Date().toISOString(), accountId: goalMode === 'allocate' || goalMode === 'release' ? goalAccountId : undefined,
      sourceAccountId: goalMode === 'transfer_in' || goalMode === 'transfer_out' ? goalSourceId : undefined,
      destinationAccountId: goalMode === 'transfer_in' || goalMode === 'transfer_out' ? goalDestinationId : undefined }), () => { setGoalAmount(''); setFeedback('Goal activity recorded.'); setFeedbackIsError(false); });
  };
  const saveEmergency = () => {
    if (!user) return;
    if (!isPositiveAmount(essential)) { setFeedback('Enter valid essential monthly costs greater than zero.'); setFeedbackIsError(true); return; }
    if (!/^\d+$/.test(months) || Number(months) < 1 || Number(months) > 60) { setFeedback('Choose a whole number of coverage months from 1 to 60.'); setFeedbackIsError(true); return; }
    void run(() => writes.saveEmergencyConfig.mutateAsync({ ownerId: user.id, currency: emergencyCurrency, essentialMonthlyMinor: essential.trim() ? parseMinorUnits(essential) : 0, coverageMonths: Number(months) }), () => { setEssentialValue(null); setMonthsValue(null); setEmergencyCurrencyValue(null); setFeedback('Emergency-fund target saved.'); setFeedbackIsError(false); });
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
      sourceAccountId: transfer ? emergencySourceId : undefined, destinationAccountId: transfer ? emergencyDestinationId : undefined }), () => { setEmergencyAmount(''); setFeedback('Emergency-fund activity recorded.'); setFeedbackIsError(false); });
  };
  const confirmArchiveGoal = (goalId: string) => {
    const archive = () => void run(() => writes.goalStatus.mutateAsync({ goalId, status: 'archived' }), () => {
      if (selectedGoal === goalId) setSelectedGoal(null);
      setFeedback('Savings goal archived; its history is preserved.'); setFeedbackIsError(false);
    });
    if (Platform.OS === 'web') {
      if (typeof globalThis.confirm === 'function' && globalThis.confirm('Archive this goal? Its contribution history will remain saved.')) archive();
      return;
    }
    Alert.alert('Archive this goal?', 'Its contribution history will remain saved.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Archive', style: 'destructive', onPress: archive },
    ]);
  };
  const closeSavings = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <DoneHeader title="Savings & Safety Net" onDone={closeSavings} />
    <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 32 }}>
      {!!error && <View className="mb-3 rounded-xl bg-red-50 dark:bg-red-950 p-3"><Text className="font-body text-sm text-red-700 dark:text-red-200">Savings could not be loaded: {error.message}</Text><Pressable accessibilityRole="button" onPress={() => void refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable></View>}
      {!!feedback && <View accessibilityRole={feedbackIsError ? 'alert' : 'text'} accessibilityLiveRegion="polite" className={`mb-3 rounded-xl border p-3 ${feedbackIsError ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950' : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950'}`}><Text className={`font-body text-sm ${feedbackIsError ? 'text-red-700 dark:text-red-200' : 'text-emerald-700 dark:text-emerald-200'}`}>{feedback}</Text></View>}
      {isLoading ? <Text className="font-body py-4 text-gray-500">Loading savings…</Text> : null}
      <View className="mb-3"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Savings goals</Text><Text className="font-body mt-1 text-sm text-gray-500 dark:text-neutral-400">Track planned targets separately from money actually set aside.</Text></View>
      {!isLoading && !error && data?.goals.length === 0 ? <View className="mb-3 rounded-2xl border border-dashed border-gray-300 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900"><Text className="font-body font-semibold text-gray-900 dark:text-white">Start with a savings goal</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Create a target below, then earmark money from an account or move it between accounts.</Text></View> : null}
      {data?.goals.map((goal) => <View key={goal.id} className="mb-3 rounded-2xl bg-white dark:bg-neutral-900 p-4">
        <View className="flex-row items-center justify-between"><Text className="font-body flex-1 pr-2 font-bold text-gray-900 dark:text-white">{goal.name}</Text><Text className="font-body rounded-full bg-gray-100 px-2 py-1 text-xs capitalize text-gray-600 dark:bg-neutral-800 dark:text-neutral-300">{goal.status}</Text></View>
        <Text className="font-heading mt-3 text-xl font-bold text-gray-900 dark:text-white">{formatMinorUnits(goal.actualMinor, goal.currency)}</Text>
        <Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">of {formatMinorUnits(goal.targetMinor, goal.currency)} saved · {goal.progress.percentComplete.toFixed(1)}%</Text>
        <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.min(100, goal.progress.percentComplete) }} className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800"><View className="h-2 rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, goal.progress.percentComplete))}%` }} /></View>
        <Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Planned {formatMinorUnits(goal.plannedMinor, goal.currency)} · plans do not change account balances</Text>
        <View className="mt-2 flex-row flex-wrap">
          {goal.status === 'active' ? <Pressable disabled={busy} onPress={() => { setEditingGoalId(goal.id); setName(goal.name); setTarget(formatMinorUnitsForInput(goal.targetMinor)); setGoalCurrency(goal.currency as CurrencyCode); }} className="mr-2 mt-2 rounded-full bg-gray-100 px-3 py-2 dark:bg-neutral-800"><Text className="font-body text-xs text-gray-700 dark:text-neutral-200">Edit</Text></Pressable> : null}
          <Pressable disabled={busy} accessibilityRole="button" onPress={() => setSelectedGoal(selectedGoal === goal.id ? null : goal.id)} className="mr-2 mt-2 rounded-full bg-gray-100 px-3 py-2 dark:bg-neutral-800"><Text className="font-body text-xs text-gray-700 dark:text-neutral-200">{selectedGoal === goal.id ? 'Hide history' : 'History'}</Text></Pressable>
          {goal.status !== 'archived' ? <Pressable disabled={busy} onPress={() => confirmArchiveGoal(goal.id)} className="mr-2 mt-2 rounded-full bg-gray-100 px-3 py-2 dark:bg-neutral-800"><Text className="font-body text-xs text-red-600 dark:text-red-300">Archive</Text></Pressable> : null}
          {goal.status === 'active' && goal.actualMinor >= goal.targetMinor ? <Pressable disabled={busy} onPress={() => void run(() => writes.goalStatus.mutateAsync({ goalId: goal.id, status: 'completed' }), () => { setFeedback('Savings goal marked complete.'); setFeedbackIsError(false); })} className="houselog-button mt-2 px-3 py-2"><Text className="font-body text-xs text-white">Complete</Text></Pressable> : null}
        </View>
        {selectedGoal === goal.id ? <View className="mt-2 border-t border-gray-100 pt-2 dark:border-neutral-800">{historyQuery.isLoading ? <Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Loading history…</Text> : null}{historyQuery.error ? <View><Text className="font-body text-xs text-red-700 dark:text-red-300">History could not be loaded: {historyQuery.error.message}</Text><Pressable accessibilityRole="button" onPress={() => void historyQuery.refetch()} className="mt-2 self-start"><Text className="font-body text-xs font-semibold text-primary">Retry</Text></Pressable></View> : null}{historyQuery.data?.length === 0 && !historyQuery.isLoading ? <Text className="font-body text-xs text-gray-500 dark:text-neutral-400">No activity recorded yet.</Text> : null}{historyQuery.data?.map((event) => <Text key={event.id} className="font-body py-1 text-xs text-gray-600 dark:text-neutral-300">{new Date(event.eventDate).toLocaleDateString()} · {event.eventType.replace('_', ' ')} · {formatMinorUnits(event.amountMinor, event.currency)}{event.note ? ` · ${event.note}` : ''}</Text>)}</View> : null}
        {goal.status === 'active' ? <View className="flex-row flex-wrap mt-2">{(['planned', 'allocate', 'release', 'transfer_in', 'transfer_out'] as EventMode[]).map((item) => <Pressable key={item} accessibilityRole="radio" accessibilityState={{ checked: selectedGoal === goal.id && goalMode === item }} onPress={() => { setSelectedGoal(goal.id); setGoalMode(item); }} className={`mr-2 mt-2 rounded-full px-3 py-2 ${selectedGoal === goal.id && goalMode === item ? 'bg-primary' : 'bg-gray-100 dark:bg-neutral-800'}`}><Text className={["font-body", (selectedGoal === goal.id && goalMode === item ? 'text-white text-xs font-bold' : 'text-gray-700 dark:text-neutral-200 text-xs')].filter(Boolean).join(' ')}>{item.replace('_', ' ')}</Text></Pressable>)}</View> : null}
      </View>)}
      <View className="mb-6 rounded-2xl bg-white dark:bg-neutral-900 p-4">
        <Text className="font-body font-bold text-gray-900 dark:text-white">{editingGoalId ? 'Edit savings goal' : 'Create a goal'}</Text>
        <View className="mt-2 flex-row flex-wrap">{(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => <Pressable key={code} accessibilityRole="radio" accessibilityState={{ checked: goalCurrency === code }} onPress={() => setGoalCurrency(code)} className={`mr-2 mt-2 rounded-full px-3 py-2 ${goalCurrency === code ? 'bg-primary' : 'bg-gray-100 dark:bg-neutral-800'}`}><Text className={["font-body", (goalCurrency === code ? 'text-white text-xs font-bold' : 'text-gray-700 dark:text-neutral-200 text-xs')].filter(Boolean).join(' ')}>{code}</Text></Pressable>)}</View>
        <TextInput accessibilityLabel="Savings goal name" value={name} onChangeText={setName} placeholder="Goal name" className="font-body mt-3 rounded-xl bg-gray-100 dark:bg-neutral-800 px-3 py-3 text-gray-900 dark:text-white" />
        <TextInput accessibilityLabel={`Savings goal target amount in ${goalCurrency}`} value={target} onChangeText={setTarget} placeholder={`Target amount (${goalCurrency})`} keyboardType="decimal-pad" className="font-body mt-2 rounded-xl bg-gray-100 dark:bg-neutral-800 px-3 py-3 text-gray-900 dark:text-white" />
        <View className="mt-3"><Button title={editingGoalId ? 'Save goal changes' : 'Create savings goal'} onPress={saveGoal} isLoading={busy} /></View>
        {editingGoalId ? <Pressable onPress={() => { setEditingGoalId(null); setName(''); setTarget(''); }} className="mt-3 self-center"><Text className="font-body text-primary">Cancel editing</Text></Pressable> : null}
      </View>
      <View className="mb-6 rounded-2xl bg-white dark:bg-neutral-900 p-4">
        <Text className="font-body font-bold text-gray-900 dark:text-white">Record goal contribution</Text>
        <Text className="font-body mt-1 text-xs text-gray-500">Select a contribution type above. Transfers are ledger transactions; earmarks only reserve existing cash.</Text>
        <TextInput accessibilityLabel={`Goal contribution amount in ${selectedGoalCurrency}`} value={goalAmount} onChangeText={setGoalAmount} placeholder={`Amount (${selectedGoalCurrency})`} keyboardType="decimal-pad" className="font-body mt-3 rounded-xl bg-gray-100 dark:bg-neutral-800 px-3 py-3 text-gray-900 dark:text-white" />
        {(goalMode === 'allocate' || goalMode === 'release') && <View className="flex-row flex-wrap">{goalAccountOptions.map((account) => <Pressable key={account.id} accessibilityRole="radio" accessibilityState={{ checked: goalAccountId === account.id }} onPress={() => setGoalAccountId(account.id)} className={`mr-2 mt-2 rounded-full px-3 py-2 ${goalAccountId === account.id ? 'bg-primary' : 'bg-gray-100 dark:bg-neutral-800'}`}><Text className={["font-body", (goalAccountId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs')].filter(Boolean).join(' ')}>{account.name}</Text></Pressable>)}{goalAccountOptions.length === 0 ? <Text className="font-body mt-2 text-xs text-amber-700 dark:text-amber-300">No active account uses {selectedGoalCurrency}. Add one in Accounts to record this activity.</Text> : null}</View>}
        {(goalMode === 'transfer_in' || goalMode === 'transfer_out') && <View className="flex-row flex-wrap">{goalAccountOptions.map((account) => <View key={account.id} className="mr-2 mt-2 flex-row rounded-full bg-gray-100 dark:bg-neutral-800"><Pressable accessibilityRole="radio" accessibilityState={{ checked: goalSourceId === account.id }} onPress={() => { setGoalSourceId(account.id); if (goalDestinationId === account.id) setGoalDestinationId(''); }} className={`rounded-full px-2 py-2 ${goalSourceId === account.id ? 'bg-primary' : ''}`}><Text className={["font-body", (goalSourceId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs')].filter(Boolean).join(' ')}>From {account.name}</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ checked: goalDestinationId === account.id }} onPress={() => { setGoalDestinationId(account.id); if (goalSourceId === account.id) setGoalSourceId(''); }} className={`rounded-full px-2 py-2 ${goalDestinationId === account.id ? 'bg-primary' : ''}`}><Text className={["font-body", (goalDestinationId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs')].filter(Boolean).join(' ')}>To {account.name}</Text></Pressable></View>)}{goalAccountOptions.length < 2 ? <Text className="font-body mt-2 text-xs text-amber-700 dark:text-amber-300">A transfer needs two active {selectedGoalCurrency} accounts.</Text> : null}</View>}
        <View className="mt-3"><Button title={`Record ${goalMode.replace('_', ' ')}`} onPress={recordGoalEvent} isLoading={busy} /></View>
      </View>
      <View className="rounded-2xl bg-primary/10 p-4">
        <Text className="font-body font-bold text-primary">Emergency fund</Text>
        <Text className="font-body mt-1 text-xs text-gray-600 dark:text-neutral-300">Enter essential monthly costs, then choose a coverage target. Goal and emergency earmarks share the same account reservations.</Text>
        <View className="mt-2 flex-row flex-wrap">{(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => <Pressable key={code} accessibilityRole="radio" accessibilityState={{ checked: emergencyCurrency === code }} onPress={() => setEmergencyCurrencyValue(code)} className={`mr-2 mt-2 rounded-full px-3 py-2 ${emergencyCurrency === code ? 'bg-primary' : 'bg-white dark:bg-neutral-900'}`}><Text className={["font-body", (emergencyCurrency === code ? 'text-white text-xs font-bold' : 'text-gray-700 dark:text-neutral-200 text-xs')].filter(Boolean).join(' ')}>{code}</Text></Pressable>)}</View>
        <TextInput accessibilityLabel={`Essential monthly costs in ${emergencyCurrency}`} value={essential} onChangeText={setEssentialValue} placeholder={`Essential monthly costs · ${CURRENCIES[emergencyCurrency].label}`} keyboardType="decimal-pad" className="font-body mt-3 rounded-xl bg-white dark:bg-neutral-900 px-3 py-3 text-gray-900 dark:text-white" />
        <TextInput accessibilityLabel="Emergency fund coverage months" value={months} onChangeText={setMonthsValue} placeholder="Coverage months (for example 3 or 6)" keyboardType="number-pad" className="font-body mt-2 rounded-xl bg-white dark:bg-neutral-900 px-3 py-3 text-gray-900 dark:text-white" />
        <View className="mt-3"><Button title="Save emergency target" onPress={saveEmergency} isLoading={busy} /></View>
        {data?.emergency ? <Text className="font-body mt-3 text-gray-800 dark:text-white">Target {formatMinorUnits(data.emergency.requiredMinor, data.emergency.currency)} · earmarked {formatMinorUnits(data.emergency.allocatedMinor, data.emergency.currency)} · {data.emergency.coverageMonthsActual.toFixed(1)} months covered</Text> : <Text className="font-body mt-3 text-gray-600 dark:text-neutral-300">No emergency-fund target saved yet.</Text>}
        <TextInput accessibilityLabel={`Emergency fund amount in ${emergencyCurrency}`} value={emergencyAmount} onChangeText={setEmergencyAmount} placeholder={`Amount to earmark or release (${emergencyCurrency})`} keyboardType="decimal-pad" className="font-body mt-3 rounded-xl bg-white dark:bg-neutral-900 px-3 py-3 text-gray-900 dark:text-white" />
        {(emergencyMode === 'transfer_in' || emergencyMode === 'transfer_out') ? <View className="flex-row flex-wrap">{emergencyAccountOptions.map((account) => <View key={account.id} className="mr-2 mt-2 flex-row rounded-full bg-white dark:bg-neutral-900"><Pressable accessibilityRole="radio" accessibilityState={{ checked: emergencySourceId === account.id }} onPress={() => { setEmergencySourceId(account.id); if (emergencyDestinationId === account.id) setEmergencyDestinationId(''); }} className={`rounded-full px-2 py-2 ${emergencySourceId === account.id ? 'bg-primary' : ''}`}><Text className={["font-body", (emergencySourceId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs')].filter(Boolean).join(' ')}>From {account.name}</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ checked: emergencyDestinationId === account.id }} onPress={() => { setEmergencyDestinationId(account.id); if (emergencySourceId === account.id) setEmergencySourceId(''); }} className={`rounded-full px-2 py-2 ${emergencyDestinationId === account.id ? 'bg-primary' : ''}`}><Text className={["font-body", (emergencyDestinationId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs')].filter(Boolean).join(' ')}>To {account.name}</Text></Pressable></View>)}{emergencyAccountOptions.length < 2 ? <Text className="font-body mt-2 text-xs text-amber-700 dark:text-amber-300">A transfer needs two active {emergencyCurrency} accounts.</Text> : null}</View>
          : <View className="mt-2">
            <Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-neutral-200">Choose an account</Text>
            <View className="flex-row flex-wrap">
              {emergencyAccountOptions.map((account) => <Pressable key={account.id} accessibilityRole="radio" accessibilityLabel={`Emergency fund account: ${account.name}`} accessibilityState={{ checked: emergencyAccountId === account.id }} onPress={() => setEmergencyAccountId(account.id)} className={`mr-2 mt-2 rounded-full border px-3 py-2 ${emergencyAccountId === account.id ? 'border-primary bg-primary' : 'border-gray-300 bg-white dark:border-neutral-600 dark:bg-neutral-800'}`}><Text className={["font-body", (emergencyAccountId === account.id ? 'text-white text-xs font-semibold' : 'text-gray-800 dark:text-white text-xs font-semibold')].filter(Boolean).join(' ')}>{account.name}</Text></Pressable>)}
            </View>
          </View>}
        <View className="mt-3 flex-row flex-wrap">{(['allocate', 'release', 'transfer_in', 'transfer_out'] as EventMode[]).map((item) => <Pressable key={item} accessibilityRole="radio" accessibilityState={{ checked: emergencyMode === item }} onPress={() => setEmergencyMode(item)} className={`mr-2 mt-2 rounded-xl px-3 py-2 ${emergencyMode === item ? 'bg-primary' : 'bg-gray-200 dark:bg-neutral-800'}`}><Text className={["font-body", (emergencyMode === item ? 'text-white' : 'text-gray-700 dark:text-neutral-200')].filter(Boolean).join(' ')}>{formatModeLabel(item)}</Text></Pressable>)}</View>
        <View className="mt-3"><Button title={`${formatModeLabel(emergencyMode)} emergency funds`} onPress={recordEmergency} isLoading={busy} /></View>
      </View>
      {!!accountsQuery.error && <View className="mt-4 rounded-xl bg-red-50 dark:bg-red-950 p-3"><Text className="font-body text-sm text-red-700 dark:text-red-200">Accounts could not be loaded: {accountsQuery.error.message}</Text><Pressable accessibilityRole="button" onPress={() => void accountsQuery.refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable></View>}
      {accountsQuery.isLoading ? <Text className="font-body mt-4 text-gray-500">Loading accounts…</Text> : null}
      {accounts.length === 0 && !accountsQuery.isLoading && !accountsQuery.error && <Pressable accessibilityRole="link" onPress={() => router.push('/accounts')} className="mt-4 rounded-xl bg-amber-50 dark:bg-amber-950 p-3"><Text className="font-body text-sm text-amber-800 dark:text-amber-200">Create an account before earmarking or transferring savings. Open accounts →</Text></Pressable>}
    </ScrollView>
  </SafeAreaView>;
}
