import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import React, { useState, useRef, useMemo, useCallback } from 'react';
import { View, Text, SectionList, TextInput, Pressable, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { Filter, Search, ShoppingCart, DollarSign, Edit, Trash2, ArrowLeftRight } from 'lucide-react-native';
import BottomSheet, { BottomSheetBackdrop, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useTransactions, type TransactionSection } from '../../hooks/queries/useTransactions';
import type { LocalTransaction } from '../../src/db/local/client';
import { formatMinorUnits } from '../../src/finance/ledger';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';

export default function TransactionsScreen() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [selectedTx, setSelectedTx] = useState<LocalTransaction | null>(null);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();

  const { data: groupedTransactions = [], isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useTransactions();
  const filteredTransactions: TransactionSection[] = groupedTransactions.map((section) => ({
    ...section,
    data: section.data.filter((tx) =>
      `${tx.category} ${tx.note}`.toLowerCase().includes(searchQuery.trim().toLowerCase())
    ),
  })).filter((section) => section.data.length > 0);
  const selectedOriginalType = selectedTx?.reversalOfId
    ? groupedTransactions.flatMap((section) => section.data).find((tx) => tx.id === selectedTx.reversalOfId)?.type
    : undefined;
  const selectedIsIncome = selectedTx?.type === 'Income' || selectedTx?.type === 'Refund' || (selectedTx?.type === 'Reversal' && selectedOriginalType === 'Expense');
  const selectedIsTransfer = selectedTx?.type === 'Transfer' || (selectedTx?.type === 'Reversal' && selectedOriginalType === 'Transfer');

  // Bottom Sheet Configuration
  const bottomSheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['40%'], []);
  
  const handlePresentModalPress = useCallback((tx: LocalTransaction) => {
    setSelectedTx(tx);
    bottomSheetRef.current?.expand();
  }, []);

  const handleClosePress = useCallback(() => {
    bottomSheetRef.current?.close();
  }, []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
      />
    ),
    []
  );

  const handleEdit = () => {
    handleClosePress();
    if (!selectedTx || selectedTx.type === 'Refund' || selectedTx.type === 'Reversal') {
      Alert.alert('Correction unavailable', 'This adjustment record cannot be edited again.');
      return;
    }
    router.push({ pathname: '/(tabs)/add', params: { correctionOf: selectedTx.id } });
  };

  const handleDelete = () => {
    Alert.alert(
      "Delete Transaction",
      "Transaction deletion is not available yet. No records have been changed.",
      [{ text: "OK", onPress: handleClosePress }]
    );
  };

  const handleRefund = () => {
    if (!selectedTx || !user || !selectedTx.accountId) return;
    Alert.alert('Record refund', 'Record any remaining refundable balance into the original account?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Record refund', onPress: () => {
        void localDb.transaction.refund({
          id: Crypto.randomUUID(), ownerId: user.id, originalTransactionId: selectedTx.id,
          accountId: selectedTx.accountId!, refundRemaining: true,
          date: new Date(), note: `Refund for ${selectedTx.category}`,
        }).then(() => {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
            queryClient.invalidateQueries({ queryKey: ['financial-report', user.id] }),
            queryClient.invalidateQueries({ queryKey: ['transactions'] }),
            queryClient.invalidateQueries({ queryKey: ['accounts', user.id] }),
          ]);
          handleClosePress();
        }).catch((error) => Alert.alert('Refund not saved', error instanceof Error ? error.message : 'Please try again.'));
      } },
    ]);
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <GlobalHeader 
        title="Transactions" 
        description="Your financial history" 
        RightIcon={<Filter size={24} color="#000" />}
      />

      {/* Search Bar */}
      <View className="px-6 pb-4">
        <View 
          className={`flex-row items-center rounded-xl border-2 bg-gray-50 px-4 py-3
            ${isFocused ? 'border-primary' : 'border-transparent'}
          `}
        >
          <Search size={20} color={isFocused ? PRIMARY_COLOR : '#9ca3af'} />
          <TextInput
            className="font-body ml-3 flex-1 text-base text-black"
            placeholder="Search by note or category..."
            placeholderTextColor="#9ca3af"
            value={searchQuery}
            onChangeText={setSearchQuery}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
          />
        </View>
      </View>

      {/* Transactions List */}
      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <Text className="font-body">Loading transactions...</Text>
        </View>
      ) : (
        <SectionList<LocalTransaction, TransactionSection>
          sections={filteredTransactions}
          onEndReached={() => { if (hasNextPage && !isFetchingNextPage) void fetchNextPage(); }}
          onEndReachedThreshold={0.4}
          ListFooterComponent={isFetchingNextPage ? <Text className="font-body py-4 text-center text-sm text-gray-500">Loading more transactions…</Text> : null}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 40 }}
          ListEmptyComponent={(
            <Text className="font-body mt-8 text-center text-sm text-gray-500">
              {isError ? 'Your transactions could not be loaded.' : searchQuery ? 'No transactions match your search.' : 'No transactions recorded yet.'}
            </Text>
          )}
          renderSectionHeader={({ section: { title } }) => (
            <View className="mb-3 mt-6 rounded-lg bg-gray-100 px-3 py-1.5 self-start">
              <Text className="font-body text-sm font-bold text-gray-700">{title}</Text>
            </View>
          )}
          renderItem={({ item }) => {
            const linkedType = item.reversalOfId ? groupedTransactions.flatMap((section) => section.data).find((tx) => tx.id === item.reversalOfId)?.type : undefined;
            const isIncome = item.type === 'Income' || item.type === 'Refund' || (item.type === 'Reversal' && linkedType === 'Expense');
            const isTransfer = item.type === 'Transfer' || (item.type === 'Reversal' && linkedType === 'Transfer');
            const Icon = isIncome ? DollarSign : isTransfer ? ArrowLeftRight : ShoppingCart;

            return (
              <Pressable 
                className="mb-4 flex-row items-center justify-between rounded-2xl bg-gray-50 p-4 active:bg-gray-100"
                onPress={() => handlePresentModalPress(item)}
              >
                <View className="flex-row items-center flex-1">
                  <View className={`h-12 w-12 items-center justify-center rounded-full ${isIncome ? 'bg-green-100' : isTransfer ? 'bg-blue-100' : 'bg-red-100'}`}>
                    <Icon size={24} color={isIncome ? '#16a34a' : isTransfer ? '#2563eb' : '#dc2626'} />
                  </View>
                  <View className="ml-4 flex-1">
                    <Text className="font-body text-base font-bold text-black" numberOfLines={1}>{item.category}</Text>
                    <Text className="font-body text-sm text-gray-500 mt-0.5" numberOfLines={1}>{item.sourceName || item.note}</Text>
                  </View>
                </View>
                <View className="items-end pl-2">
                  <Text className={["font-body", (`text-base font-bold ${isIncome ? 'text-green-600' : isTransfer ? 'text-blue-600' : 'text-red-600'}`)].filter(Boolean).join(' ')}>
                    {isIncome ? '+' : isTransfer ? '↔' : '-'} {formatMinorUnits(item.amountMinor, item.accountCurrency ?? 'PKR')}
                  </Text>
                  <Text className="font-body text-xs text-gray-400 mt-0.5">{new Date(item.date).toLocaleDateString()}</Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}

      {/* Edit/Delete Bottom Sheet */}
      <BottomSheet
        ref={bottomSheetRef}
        index={-1}
        snapPoints={snapPoints}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        handleIndicatorStyle={{ backgroundColor: '#d1d5db', width: 40 }}
      >
        {selectedTx && (
          <View className="flex-1 px-6 pt-2">
            <View className="items-center mb-8">
              <Text className="font-body text-gray-500 mb-1">{selectedTx.category} • {selectedTx.date}</Text>
              <Text className={["font-heading", (`text-4xl font-bold ${selectedIsIncome ? 'text-green-600' : selectedIsTransfer ? 'text-blue-600' : 'text-red-600'}`)].filter(Boolean).join(' ')}>
                {selectedIsIncome ? '+' : selectedIsTransfer ? '↔' : '-'} {formatMinorUnits(selectedTx.amountMinor, selectedTx.accountCurrency ?? 'PKR')}
              </Text>
              <Text className="font-body text-base text-gray-700 mt-2 text-center">{selectedTx.sourceName || selectedTx.note}</Text>
              {!!selectedTx.paymentMethod && <Text className="font-body mt-1 text-sm text-gray-500">Received by {selectedTx.paymentMethod}</Text>}
              {!!selectedTx.sourceAmountMinor && !!selectedTx.sourceCurrency && <Text className="font-body mt-1 text-sm text-gray-600">Original: {formatMinorUnits(selectedTx.sourceAmountMinor, selectedTx.sourceCurrency)} · Rate: PKR {selectedTx.exchangeRate}</Text>}
              {!!selectedTx.referenceNumber && <Text className="font-body mt-1 text-sm text-gray-600">Reference: {selectedTx.referenceNumber}</Text>}
              {selectedTx.type === 'Income' && <Text className="font-body mt-1 text-sm text-gray-600">Tax record: {selectedTx.taxStatus === 'taxable' ? 'Taxable' : selectedTx.taxStatus === 'non_taxable' ? 'Marked non-taxable' : 'Not reviewed'}</Text>}
            </View>

            <Pressable 
              className="houselog-button flex-row items-center justify-center py-4 mb-3"
              onPress={handleEdit}
            >
              <Edit size={20} color="#ffffff" className="mr-2" />
              <Text className="font-body text-base font-bold text-white">Edit Transaction</Text>
            </Pressable>

            {selectedTx.type === 'Expense' && (
              <Pressable className="mb-3 items-center justify-center rounded-xl border-2 border-green-600 py-4" onPress={handleRefund}>
                <Text className="font-body text-base font-bold text-green-700">Refund remaining balance</Text>
              </Pressable>
            )}

            <Pressable 
              className="flex-row items-center justify-center rounded-xl border-2 border-red-500 py-4"
              onPress={handleDelete}
            >
              <Trash2 size={20} color="#ef4444" className="mr-2" />
              <Text className="font-body text-base font-bold text-red-500">Delete Transaction</Text>
            </Pressable>
          </View>
        )}
      </BottomSheet>
    </SafeAreaView>
  );
}
