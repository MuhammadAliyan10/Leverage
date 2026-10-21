import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../src/context/AuthContext';
import { useAccounts } from '../hooks/queries/useAccounts';
import { useBudgetingWrites, useSavingsOverview } from '../hooks/queries/useBudgeting';
import { localDb } from '../src/db/local/client';
import { formatMinorUnits, parseMinorUnits } from '../src/finance/ledger';
import { CURRENCIES, type CurrencyCode } from '../src/finance/domain';
import { Button } from '../components/ui/Button';

const requestId = () => `houselog-${Date.now()}-${Math.random().toString(36).slice(2)}`;
type EventMode = 'planned' | 'allocate' | 'release' | 'transfer_in' | 'transfer_out';

export default function SavingsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { data, isLoading, error } = useSavingsOverview();
  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data ?? [];
  const writes = useBudgetingWrites();
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [essential, setEssential] = useState('');
  const [months, setMonths] = useState('3');
  const [mode, setMode] = useState<EventMode>('planned');
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null);
  const [accountId, setAccountId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode>('PKR');
  const [busy, setBusy] = useState(false);
  const accountOptions = accounts.filter((account) => account.currency === currency);
  const historyQuery = useQuery({
    queryKey: ['savings-history', user?.id, selectedGoal],
    enabled: !!user && !!selectedGoal,
    queryFn: async () => {
      if (!user || !selectedGoal) return [];
      return localDb.savings.history(user.id, selectedGoal);
    },
  });

  const run = async (task: () => Promise<unknown>, success?: () => void) => {
    setBusy(true);
    try { await task(); success?.(); }
    catch (e) { Alert.alert('Could not save', e instanceof Error ? e.message : 'Please try again.'); }
    finally { setBusy(false); }
  };
  const saveGoal = () => {
    if (!user) return;
    void run(async () => writes.saveGoal.mutateAsync({ id: editingGoalId ?? requestId(), ownerId: user.id, name, targetMinor: parseMinorUnits(target), currency, targetDate: null }), () => { setName(''); setTarget(''); setEditingGoalId(null); });
  };
  const recordGoalEvent = () => {
    if (!user || !selectedGoal) return Alert.alert('Choose a goal', 'Select a goal before recording a contribution.');
    const amountMinor = parseMinorUnits(amount);
    const account = mode === 'allocate' || mode === 'release' ? accountId : undefined;
    const transfer = mode === 'transfer_in' || mode === 'transfer_out';
    void run(() => writes.goalEvent.mutateAsync({ id: requestId(), ownerId: user.id, goalId: selectedGoal, eventType: mode, amountMinor,
      eventDate: new Date().toISOString(), accountId: account, sourceAccountId: transfer ? sourceId : undefined, destinationAccountId: transfer ? destinationId : undefined }), () => setAmount(''));
  };
  const saveEmergency = () => {
    if (!user) return;
    void run(() => writes.saveEmergencyConfig.mutateAsync({ ownerId: user.id, currency, essentialMonthlyMinor: essential.trim() ? parseMinorUnits(essential) : 0, coverageMonths: Number(months) }));
  };
  const recordEmergency = () => {
    if (!user) return;
    const transfer = mode === 'transfer_in' || mode === 'transfer_out';
    if (transfer ? (!sourceId || !destinationId) : !accountId) return Alert.alert('Choose an account', 'Select the account or both transfer accounts first.');
    void run(() => writes.emergencyEvent.mutateAsync({ id: requestId(), ownerId: user.id,
      eventType: mode === 'release' || mode === 'transfer_out' ? mode : mode === 'transfer_in' ? 'transfer_in' : 'allocate',
      amountMinor: parseMinorUnits(amount), eventDate: new Date().toISOString(), accountId: transfer ? undefined : accountId,
      sourceAccountId: transfer ? sourceId : undefined, destinationAccountId: transfer ? destinationId : undefined }), () => setAmount(''));
  };

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <View className="flex-row items-center px-5 py-4 border-b border-gray-200 dark:border-neutral-800">
      <Pressable onPress={() => router.back()}><Text className="font-bold text-primary">Done</Text></Pressable>
      <Text className="flex-1 text-center font-bold text-lg dark:text-white">Savings & Safety Net</Text><View className="w-10" />
    </View>
    <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 32 }}>
      {!!error && <Text className="mb-3 text-red-600">{error.message}</Text>}
      {isLoading ? <Text className="py-4 text-gray-500">Loading savings…</Text> : null}
      <Text className="mb-3 text-lg font-bold text-gray-900 dark:text-white">Savings goals</Text>
      {data?.goals.map((goal) => <View key={goal.id} className="mb-3 rounded-2xl bg-white dark:bg-neutral-900 p-4">
        <View className="flex-row justify-between"><Text className="font-bold text-gray-900 dark:text-white">{goal.name}</Text><Text className="text-xs text-gray-500">{goal.status}</Text></View>
        <Text className="mt-2 text-gray-700 dark:text-neutral-200">{formatMinorUnits(goal.actualMinor, goal.currency)} of {formatMinorUnits(goal.targetMinor, goal.currency)} · {goal.progress.percentComplete.toFixed(1)}%</Text>
        <Text className="mt-1 text-xs text-gray-500 dark:text-neutral-400">Planned {formatMinorUnits(goal.plannedMinor, goal.currency)} · plans do not change account balances</Text>
        <View className="mt-2 flex-row flex-wrap">
          <Pressable onPress={() => { setEditingGoalId(goal.id); setName(goal.name); setTarget((goal.targetMinor / 100).toFixed(2)); setCurrency(goal.currency as CurrencyCode); }} className="mr-2 mt-2 rounded-full bg-gray-100 dark:bg-neutral-800 px-3 py-2"><Text className="text-xs text-gray-700 dark:text-neutral-200">Edit</Text></Pressable>
          <Pressable onPress={() => setSelectedGoal(selectedGoal === goal.id ? null : goal.id)} className="mr-2 mt-2 rounded-full bg-gray-100 dark:bg-neutral-800 px-3 py-2"><Text className="text-xs text-gray-700 dark:text-neutral-200">{selectedGoal === goal.id ? 'Hide history' : 'History'}</Text></Pressable>
          <Pressable onPress={() => Alert.alert('Archive this goal?', 'Its contribution history will remain saved.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Archive', style: 'destructive', onPress: () => writes.goalStatus.mutate({ goalId: goal.id, status: 'archived' }, { onError: (e) => Alert.alert('Could not archive', e.message) }) }])} className="mr-2 mt-2 rounded-full bg-gray-100 dark:bg-neutral-800 px-3 py-2"><Text className="text-xs text-red-600">Archive</Text></Pressable>
          {goal.actualMinor >= goal.targetMinor ? <Pressable onPress={() => writes.goalStatus.mutate({ goalId: goal.id, status: 'completed' }, { onError: (e) => Alert.alert('Could not complete', e.message) })} className="mt-2 rounded-full bg-primary px-3 py-2"><Text className="text-xs text-white">Complete</Text></Pressable> : null}
        </View>
        {selectedGoal === goal.id ? <View className="mt-2 border-t border-gray-100 dark:border-neutral-800 pt-2">{historyQuery.data?.map((event) => <Text key={event.id} className="py-1 text-xs text-gray-600 dark:text-neutral-300">{new Date(event.eventDate).toLocaleDateString()} · {event.eventType.replace('_', ' ')} · {formatMinorUnits(event.amountMinor, event.currency)}{event.note ? ` · ${event.note}` : ''}</Text>)}</View> : null}
        {goal.status === 'active' ? <View className="flex-row flex-wrap mt-2">{(['planned', 'allocate', 'release', 'transfer_in', 'transfer_out'] as EventMode[]).map((item) => <Pressable key={item} onPress={() => { setSelectedGoal(goal.id); setMode(item); setCurrency(goal.currency as CurrencyCode); }} className={`mr-2 mt-2 rounded-full px-3 py-2 ${selectedGoal === goal.id && mode === item ? 'bg-primary' : 'bg-gray-100 dark:bg-neutral-800'}`}><Text className={selectedGoal === goal.id && mode === item ? 'text-white text-xs font-bold' : 'text-gray-700 dark:text-neutral-200 text-xs'}>{item.replace('_', ' ')}</Text></Pressable>)}</View> : null}
      </View>)}
      <View className="mb-6 rounded-2xl bg-white dark:bg-neutral-900 p-4">
        <Text className="font-bold text-gray-900 dark:text-white">{editingGoalId ? 'Edit savings goal' : 'Create a goal'}</Text>
        <View className="mt-2 flex-row flex-wrap">{(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => <Pressable key={code} onPress={() => setCurrency(code)} className={`mr-2 mt-2 rounded-full px-3 py-2 ${currency === code ? 'bg-primary' : 'bg-gray-100 dark:bg-neutral-800'}`}><Text className={currency === code ? 'text-white text-xs font-bold' : 'text-gray-700 dark:text-neutral-200 text-xs'}>{code}</Text></Pressable>)}</View>
        <TextInput value={name} onChangeText={setName} placeholder="Goal name" className="mt-3 rounded-xl bg-gray-100 dark:bg-neutral-800 px-3 py-3 text-gray-900 dark:text-white" />
        <TextInput value={target} onChangeText={setTarget} placeholder="Target amount (PKR)" keyboardType="decimal-pad" className="mt-2 rounded-xl bg-gray-100 dark:bg-neutral-800 px-3 py-3 text-gray-900 dark:text-white" />
        <Button title={editingGoalId ? 'Save goal changes' : 'Create savings goal'} onPress={saveGoal} isLoading={busy} />
        {editingGoalId ? <Pressable onPress={() => { setEditingGoalId(null); setName(''); setTarget(''); }} className="mt-3 self-center"><Text className="text-primary">Cancel editing</Text></Pressable> : null}
      </View>
      <View className="mb-6 rounded-2xl bg-white dark:bg-neutral-900 p-4">
        <Text className="font-bold text-gray-900 dark:text-white">Record goal contribution</Text>
        <Text className="mt-1 text-xs text-gray-500">Select a contribution type above. Transfers are ledger transactions; earmarks only reserve existing cash.</Text>
        <TextInput value={amount} onChangeText={setAmount} placeholder="Amount" keyboardType="decimal-pad" className="mt-3 rounded-xl bg-gray-100 dark:bg-neutral-800 px-3 py-3 text-gray-900 dark:text-white" />
        {(mode === 'allocate' || mode === 'release') && <View className="flex-row flex-wrap">{accountOptions.map((account) => <Pressable key={account.id} onPress={() => setAccountId(account.id)} className={`mr-2 mt-2 rounded-full px-3 py-2 ${accountId === account.id ? 'bg-primary' : 'bg-gray-100 dark:bg-neutral-800'}`}><Text className={accountId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs'}>{account.name}</Text></Pressable>)}</View>}
        {(mode === 'transfer_in' || mode === 'transfer_out') && <View className="flex-row flex-wrap">{accountOptions.map((account) => <View key={account.id} className="mr-2 mt-2 flex-row rounded-full bg-gray-100 dark:bg-neutral-800"><Pressable onPress={() => setSourceId(account.id)} className={`rounded-full px-2 py-2 ${sourceId === account.id ? 'bg-primary' : ''}`}><Text className={sourceId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs'}>From {account.name}</Text></Pressable><Pressable onPress={() => setDestinationId(account.id)} className={`rounded-full px-2 py-2 ${destinationId === account.id ? 'bg-primary' : ''}`}><Text className={destinationId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs'}>To {account.name}</Text></Pressable></View>)}</View>}
        <Button title={`Record ${mode.replace('_', ' ')}`} onPress={recordGoalEvent} isLoading={busy} />
      </View>
      <View className="rounded-2xl bg-primary/10 p-4">
        <Text className="font-bold text-primary">Emergency fund</Text>
        <Text className="mt-1 text-xs text-gray-600 dark:text-neutral-300">Enter essential monthly costs, then choose a coverage target. Goal and emergency earmarks share the same account reservations.</Text>
        <View className="mt-2 flex-row flex-wrap">{(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => <Pressable key={code} onPress={() => setCurrency(code)} className={`mr-2 mt-2 rounded-full px-3 py-2 ${currency === code ? 'bg-primary' : 'bg-white dark:bg-neutral-900'}`}><Text className={currency === code ? 'text-white text-xs font-bold' : 'text-gray-700 dark:text-neutral-200 text-xs'}>{code}</Text></Pressable>)}</View>
        <TextInput value={essential} onChangeText={setEssential} placeholder={`Essential monthly costs · ${CURRENCIES[currency].label}`} keyboardType="decimal-pad" className="mt-3 rounded-xl bg-white dark:bg-neutral-900 px-3 py-3 text-gray-900 dark:text-white" />
        <TextInput value={months} onChangeText={setMonths} placeholder="Coverage months (for example 3 or 6)" keyboardType="number-pad" className="mt-2 rounded-xl bg-white dark:bg-neutral-900 px-3 py-3 text-gray-900 dark:text-white" />
        <Button title="Save emergency target" onPress={saveEmergency} isLoading={busy} />
        {data?.emergency ? <Text className="mt-3 text-gray-800 dark:text-white">Target {formatMinorUnits(data.emergency.requiredMinor, data.emergency.currency)} · earmarked {formatMinorUnits(data.emergency.allocatedMinor, data.emergency.currency)} · {data.emergency.coverageMonthsActual.toFixed(1)} months covered</Text> : <Text className="mt-3 text-gray-600 dark:text-neutral-300">No emergency-fund target saved yet.</Text>}
        <TextInput value={amount} onChangeText={setAmount} placeholder="Amount to earmark or release" keyboardType="decimal-pad" className="mt-3 rounded-xl bg-white dark:bg-neutral-900 px-3 py-3 text-gray-900 dark:text-white" />
        {(mode === 'transfer_in' || mode === 'transfer_out') ? <View className="flex-row flex-wrap">{accountOptions.map((account) => <View key={account.id} className="mr-2 mt-2 flex-row rounded-full bg-white dark:bg-neutral-900"><Pressable onPress={() => setSourceId(account.id)} className={`rounded-full px-2 py-2 ${sourceId === account.id ? 'bg-primary' : ''}`}><Text className={sourceId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs'}>From {account.name}</Text></Pressable><Pressable onPress={() => setDestinationId(account.id)} className={`rounded-full px-2 py-2 ${destinationId === account.id ? 'bg-primary' : ''}`}><Text className={destinationId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs'}>To {account.name}</Text></Pressable></View>)}</View>
          : <View className="flex-row flex-wrap">{accountOptions.map((account) => <Pressable key={account.id} onPress={() => setAccountId(account.id)} className={`mr-2 mt-2 rounded-full px-3 py-2 ${accountId === account.id ? 'bg-primary' : 'bg-white dark:bg-neutral-900'}`}><Text className={accountId === account.id ? 'text-white text-xs' : 'text-gray-700 dark:text-neutral-200 text-xs'}>{account.name}</Text></Pressable>)}</View>}
        <View className="mt-3 flex-row flex-wrap">{(['allocate', 'release', 'transfer_in', 'transfer_out'] as EventMode[]).map((item) => <Pressable key={item} onPress={() => setMode(item)} className={`mr-2 mt-2 rounded-xl px-3 py-2 ${mode === item ? 'bg-primary' : 'bg-gray-200 dark:bg-neutral-800'}`}><Text className={mode === item ? 'text-white' : 'text-gray-700 dark:text-neutral-200'}>{item.replace('_', ' ')}</Text></Pressable>)}</View>
        <Button title={`${mode.replace('_', ' ')} emergency funds`} onPress={recordEmergency} isLoading={busy} />
      </View>
      {accountsQuery.isLoading ? <Text className="mt-4 text-gray-500">Loading accounts…</Text> : null}
      {accounts.length === 0 && <Text className="mt-4 text-amber-700">Create an account before earmarking or transferring savings.</Text>}
    </ScrollView>
  </SafeAreaView>;
}
