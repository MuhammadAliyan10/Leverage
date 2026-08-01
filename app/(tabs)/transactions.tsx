import React, { useState, useRef, useMemo, useCallback } from 'react';
import { View, Text, SafeAreaView, SectionList, TextInput, Pressable, Alert } from 'react-native';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { Filter, Search, ShoppingCart, DollarSign, Edit, Trash2 } from 'lucide-react-native';
import BottomSheet, { BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { useTransactions } from '../../hooks/queries/useTransactions';

interface Transaction {
  id: string;
  amount: number;
  type: 'income' | 'expense';
  category: string;
  date: string;
  note: string;
  icon: any;
}

export default function TransactionsScreen() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

  const { data: groupedTransactions = [], isLoading } = useTransactions();

  // Bottom Sheet Configuration
  const bottomSheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['40%'], []);
  
  const handlePresentModalPress = useCallback((tx: Transaction) => {
    setSelectedTx(tx);
    bottomSheetRef.current?.expand();
  }, []);

  const handleClosePress = useCallback(() => {
    bottomSheetRef.current?.close();
  }, []);

  const renderBackdrop = useCallback(
    (props: any) => (
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
    console.log("Edit Transaction", selectedTx?.id);
  };

  const handleDelete = () => {
    Alert.alert(
      "Delete Transaction",
      "Are you sure you want to delete this transaction?",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Delete", 
          style: "destructive",
          onPress: () => {
            console.log("Deleted Transaction", selectedTx?.id);
            handleClosePress();
          }
        }
      ]
    );
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
          <Search size={20} color={isFocused ? '#533AFE' : '#9ca3af'} />
          <TextInput
            className="ml-3 flex-1 text-base text-black"
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
          <Text>Loading transactions...</Text>
        </View>
      ) : (
        <SectionList
          sections={groupedTransactions as any}
          keyExtractor={(item: any) => item.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 40 }}
          renderSectionHeader={({ section: { title } }) => (
            <View className="mb-3 mt-6 rounded-lg bg-gray-100 px-3 py-1.5 self-start">
              <Text className="text-sm font-bold text-gray-700">{title}</Text>
            </View>
          )}
          renderItem={({ item }) => {
            const isIncome = item.type === 'Income';
            const Icon = isIncome ? DollarSign : ShoppingCart;

            return (
              <Pressable 
                className="mb-4 flex-row items-center justify-between rounded-2xl bg-gray-50 p-4 active:bg-gray-100"
                onPress={() => handlePresentModalPress(item as any)}
              >
                <View className="flex-row items-center flex-1">
                  <View className={`h-12 w-12 items-center justify-center rounded-full ${isIncome ? 'bg-green-100' : 'bg-red-100'}`}>
                    <Icon size={24} color={isIncome ? '#16a34a' : '#dc2626'} />
                  </View>
                  <View className="ml-4 flex-1">
                    <Text className="text-base font-bold text-black" numberOfLines={1}>{item.category}</Text>
                    <Text className="text-sm text-gray-500 mt-0.5" numberOfLines={1}>{item.note}</Text>
                  </View>
                </View>
                <View className="items-end pl-2">
                  <Text className={`text-base font-bold ${isIncome ? 'text-green-600' : 'text-red-600'}`}>
                    {isIncome ? '+' : '-'} ₨ {Math.abs(item.amount).toLocaleString()}
                  </Text>
                  <Text className="text-xs text-gray-400 mt-0.5">{new Date(item.date).toLocaleDateString()}</Text>
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
              <Text className="text-gray-500 mb-1">{selectedTx.category} • {selectedTx.date}</Text>
              <Text className={`text-4xl font-bold ${selectedTx.type === 'income' ? 'text-green-600' : 'text-red-600'}`}>
                {selectedTx.type === 'income' ? '+' : '-'} ₨ {Math.abs(selectedTx.amount).toLocaleString()}
              </Text>
              <Text className="text-base text-gray-700 mt-2 text-center">{selectedTx.note}</Text>
            </View>

            <Pressable 
              className="flex-row items-center justify-center rounded-xl bg-primary py-4 mb-3"
              onPress={handleEdit}
            >
              <Edit size={20} color="#ffffff" className="mr-2" />
              <Text className="text-base font-bold text-white">Edit Transaction</Text>
            </Pressable>

            <Pressable 
              className="flex-row items-center justify-center rounded-xl border-2 border-red-500 py-4"
              onPress={handleDelete}
            >
              <Trash2 size={20} color="#ef4444" className="mr-2" />
              <Text className="text-base font-bold text-red-500">Delete Transaction</Text>
            </Pressable>
          </View>
        )}
      </BottomSheet>
    </SafeAreaView>
  );
}
