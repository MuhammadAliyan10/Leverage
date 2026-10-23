import { PRIMARY_COLOR } from '../src/constants/themeColors';
import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ArrowLeft, Archive, Plus, Save } from 'lucide-react-native';
import { GlobalHeader } from '../components/ui/GlobalHeader';
import { useAccounts } from '../hooks/queries/useAccounts';
import { useAuth } from '../src/context/AuthContext';
import { localDb } from '../src/db/local/client';
import { ACCOUNT_TYPES, CURRENCIES, type AccountType, type CurrencyCode } from '../src/finance/domain';
import { formatMinorUnits, parseMinorUnits } from '../src/finance/ledger';

export default function AccountsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: accounts = [], isLoading, isError } = useAccounts();
  const recordsQuery = useQuery({
    queryKey: ['account-records', user?.id],
    enabled: !!user,
    queryFn: () => {
      if (!user) throw new Error('Sign in to manage accounts.');
      return localDb.account.findMany(user.id);
    },
  });
  const records = recordsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = records.find((account) => account.id === selectedId) ?? null;
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('bank');
  const [currency, setCurrency] = useState<CurrencyCode>('PKR');
  const [openingBalance, setOpeningBalance] = useState('0.00');
  const [busy, setBusy] = useState(false);
  const currencyOptions = useMemo(() => Object.keys(CURRENCIES) as CurrencyCode[], []);

  const beginCreate = () => {
    setSelectedId(null); setName(''); setType('bank'); setCurrency('PKR'); setOpeningBalance('0.00');
  };
  const beginEdit = (account: typeof records[number]) => {
    setSelectedId(account.id); setName(account.name); setType(account.type as AccountType); setCurrency(account.currency as CurrencyCode); setOpeningBalance((account.balanceMinor / 100).toFixed(2));
  };
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['accounts', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['account-records', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['transactions'] }),
    ]);
  };
  const save = async () => {
    if (!user || busy) return;
    setBusy(true);
    try {
      const balanceText = openingBalance.trim();
      const balanceMinor = /^0(?:\.0{1,2})?$/.test(balanceText) ? 0 : parseMinorUnits(balanceText);
      if (selectedId) await localDb.account.update({ ownerId: user.id, accountId: selectedId, changes: { name, type, currency, balanceMinor } });
      else await localDb.account.create({ data: { ownerId: user.id, name, type, currency, balanceMinor } });
      await refresh();
      beginCreate();
    } catch (error) {
      Alert.alert('Account not saved', error instanceof Error ? error.message : 'Check the details and try again.');
    } finally { setBusy(false); }
  };
  const archive = (accountId: string, accountName: string) => Alert.alert('Archive account', `Archive “${accountName}”? Its transaction history will remain available.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Archive', style: 'destructive', onPress: () => {
      void localDb.account.archive({ ownerId: user?.id ?? '', accountId }).then(refresh).then(beginCreate).catch((error) => Alert.alert('Account not archived', error instanceof Error ? error.message : 'Please try again.'));
    } },
  ]);

  return <SafeAreaView className="flex-1 bg-white">
    <GlobalHeader title="Accounts" description="Balances and account details" onRightPress={() => router.back()} RightIcon={<ArrowLeft size={22} color="#111827" />} />
    <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <View className="mb-6 rounded-3xl bg-gray-50 p-5">
        <Text className="font-heading mb-4 text-lg font-bold text-gray-900">{selected ? 'Edit account' : 'Add account'}</Text>
        <Text className="font-body mb-1 text-sm font-semibold text-gray-600">Account name</Text>
        <TextInput value={name} onChangeText={setName} placeholder="e.g. Main bank" className="font-body mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-base text-gray-900" />
        <Text className="font-body mb-2 text-sm font-semibold text-gray-600">Account type</Text>
        <View className="mb-4 flex-row flex-wrap">{ACCOUNT_TYPES.map((option) => <Pressable key={option.id} onPress={() => setType(option.id)} className={`mb-2 mr-2 rounded-full border px-3 py-2 ${type === option.id ? 'border-primary bg-primary/10' : 'border-gray-200 bg-white'}`}><Text className={["font-body", (type === option.id ? 'font-semibold text-primary' : 'text-gray-600')].filter(Boolean).join(' ')}>{option.label}</Text></Pressable>)}</View>
        <Text className="font-body mb-2 text-sm font-semibold text-gray-600">Currency</Text>
        <View className="mb-4 flex-row flex-wrap">{currencyOptions.map((code) => <Pressable key={code} onPress={() => setCurrency(code)} className={`mb-2 mr-2 rounded-full border px-3 py-2 ${currency === code ? 'border-primary bg-primary/10' : 'border-gray-200 bg-white'}`}><Text className={["font-body", (currency === code ? 'font-semibold text-primary' : 'text-gray-600')].filter(Boolean).join(' ')}>{code}</Text></Pressable>)}</View>
        <Text className="font-body mb-1 text-sm font-semibold text-gray-600">Opening balance</Text>
        <TextInput value={openingBalance} onChangeText={setOpeningBalance} keyboardType="decimal-pad" placeholder="0.00" className="font-body mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-base text-gray-900" />
        {!!selected && <Text className="font-body mb-3 text-xs leading-5 text-gray-500">Opening balance and currency are locked after transactions are recorded so account history stays consistent.</Text>}
        <View className="flex-row">
          <Pressable disabled={busy} onPress={() => void save()} className="houselog-button flex-1 flex-row items-center justify-center py-3"><Save size={18} color="white" /><Text className="font-body ml-2 font-bold text-white">{busy ? 'Saving…' : selected ? 'Save changes' : 'Create account'}</Text></Pressable>
          {selected && <Pressable onPress={beginCreate} className="ml-2 justify-center rounded-xl border border-gray-300 px-4"><Text className="font-body font-semibold text-gray-700">Cancel</Text></Pressable>}
        </View>
      </View>

      <View className="mb-3 flex-row items-center justify-between"><Text className="font-heading text-lg font-bold text-gray-900">Your accounts</Text><Pressable onPress={beginCreate} className="flex-row items-center"><Plus size={18} color={PRIMARY_COLOR} /><Text className="font-body ml-1 font-semibold text-primary">Add</Text></Pressable></View>
      {isLoading || recordsQuery.isLoading ? <Text className="font-body py-5 text-center text-gray-500">Loading accounts…</Text> : isError || recordsQuery.isError ? <Text className="font-body py-5 text-center text-red-600">Accounts could not be loaded.</Text> : accounts.length === 0 ? <Text className="font-body rounded-2xl bg-gray-50 p-5 text-center text-gray-500">No accounts yet. Add one to start recording money.</Text> : accounts.map((account) => <View key={account.id} className="mb-3 flex-row items-center rounded-2xl border border-gray-100 bg-white p-4">
        <Pressable onPress={() => { const raw = records.find((item) => item.id === account.id); if (raw) beginEdit(raw); }} className="flex-1"><Text className="font-body font-bold text-gray-900">{account.name}</Text><Text className="font-body mt-1 text-xs text-gray-500">{account.type} · {account.currency} · Opening {formatMinorUnits(records.find((item) => item.id === account.id)?.balanceMinor ?? 0, account.currency)}</Text><Text className="font-heading mt-2 text-lg font-bold text-primary">{formatMinorUnits(account.balanceMinor, account.currency)}</Text></Pressable>
        <Pressable accessibilityLabel={`Archive ${account.name}`} onPress={() => archive(account.id, account.name)} className="ml-3 rounded-full bg-gray-100 p-3"><Archive size={18} color="#6b7280" /></Pressable>
      </View>)}
    </ScrollView>
  </SafeAreaView>;
}
