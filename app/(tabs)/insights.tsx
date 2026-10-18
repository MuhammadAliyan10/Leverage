import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { ChevronLeft, ChevronRight, ShoppingCart, Home, Car, Zap, Coffee, CircleDollarSign } from 'lucide-react-native';
import { PieChart } from 'react-native-gifted-charts';
import { useTransactions } from '../../hooks/queries/useTransactions';
import { formatMinorUnits } from '../../src/finance/ledger';

const CATEGORY_STYLES: Record<string, { color: string; icon: any }> = {
  Food: { color: '#533AFE', icon: ShoppingCart },
  Groceries: { color: '#533AFE', icon: ShoppingCart },
  'Rent & Utilities': { color: '#7b61ff', icon: Home },
  Transport: { color: '#a08bff', icon: Car },
  Bills: { color: '#c5b5ff', icon: Zap },
  Entertainment: { color: '#e0d8ff', icon: Coffee },
  Income: { color: '#16a34a', icon: CircleDollarSign },
};

type Transaction = {
  id: string;
  amountMinor: number;
  type: 'Income' | 'Expense' | 'Transfer';
  category: string;
  date: string;
  note: string;
};

function checkedTotal(values: number[]): number {
  const total = values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('A saved transaction amount is invalid.');
    return sum + BigInt(value);
  }, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Monthly spending is out of range.');
  return Number(total);
}

export default function InsightsScreen() {
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const { data: sections = [], isLoading, isError } = useTransactions();
  const allTransactions = sections.flatMap((section: any) => section.data) as Transaction[];

  const { categories, largestTransactions, totalSpentMinor, pieData } = useMemo(() => {
    const monthTransactions = allTransactions.filter((tx) => {
      const date = new Date(tx.date);
      if (Number.isNaN(date.getTime())) throw new Error('A transaction has an invalid date.');
      return date.getFullYear() === selectedMonth.getFullYear()
        && date.getMonth() === selectedMonth.getMonth();
    });
    const expenses = monthTransactions.filter((tx) => tx.type === 'Expense');
    const categoryTotals = new Map<string, number[]>();
    for (const tx of expenses) {
      const values = categoryTotals.get(tx.category) ?? [];
      values.push(tx.amountMinor);
      categoryTotals.set(tx.category, values);
    }
    const categories = Array.from(categoryTotals, ([name, amounts]) => ({
      name,
      amountMinor: checkedTotal(amounts),
      ...(CATEGORY_STYLES[name] ?? { color: '#9ca3af', icon: ShoppingCart }),
    })).sort((a, b) => b.amountMinor - a.amountMinor);
    const totalSpentMinor = checkedTotal(expenses.map((tx) => tx.amountMinor));
    return {
      categories,
      largestTransactions: [...expenses].sort((a, b) => b.amountMinor - a.amountMinor).slice(0, 5),
      totalSpentMinor,
      // Chart geometry uses major currency units; totals and rankings stay in exact minor units.
      pieData: categories.map((category) => ({ value: category.amountMinor / 100, color: category.color })),
    };
  }, [allTransactions, selectedMonth]);

  const monthLabel = selectedMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <SafeAreaView className="flex-1 bg-gray-50">
      <GlobalHeader title="Insights" description="Understand where your money goes" />

      <ScrollView className="flex-1 px-6 pt-4" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        <View className="mb-6 flex-row items-center justify-between rounded-2xl bg-white p-4 shadow-sm shadow-gray-200">
          <Pressable
            accessibilityLabel="Previous month"
            className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 active:bg-gray-200"
            onPress={() => setSelectedMonth((date) => new Date(date.getFullYear(), date.getMonth() - 1, 1))}
          >
            <ChevronLeft size={20} color="#374151" />
          </Pressable>
          <Text className="text-lg font-bold text-gray-800">{monthLabel}</Text>
          <Pressable
            accessibilityLabel="Next month"
            className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 active:bg-gray-200"
            onPress={() => setSelectedMonth((date) => new Date(date.getFullYear(), date.getMonth() + 1, 1))}
          >
            <ChevronRight size={20} color="#374151" />
          </Pressable>
        </View>

        {isError ? (
          <View className="mb-6 rounded-3xl bg-white px-6 py-8 shadow-sm shadow-gray-200">
            <Text className="text-center font-semibold text-gray-800">We couldn’t load your spending data.</Text>
            <Text className="mt-2 text-center text-sm text-gray-500">Your saved records have not been changed.</Text>
          </View>
        ) : <View className="mb-6 items-center justify-center rounded-3xl bg-white py-8 shadow-sm shadow-gray-200">
          {totalSpentMinor > 0 ? (
            <PieChart
              donut
              innerRadius={76}
              radius={104}
              data={pieData}
              centerLabelComponent={() => (
                <View className="items-center justify-center px-1">
                  <Text className="mb-1 text-sm font-semibold text-gray-500">Spent this month</Text>
                  <Text className="text-xl font-bold text-black">{formatMinorUnits(totalSpentMinor)}</Text>
                </View>
              )}
            />
          ) : (
            <View className="items-center px-8 py-10">
              <Text className="text-lg font-bold text-gray-900">No spending recorded</Text>
              <Text className="mt-2 text-center text-sm text-gray-500">Expenses you add for {monthLabel} will appear here.</Text>
            </View>
          )}
        </View>}

        <View className="mb-8 rounded-3xl bg-white p-5 shadow-sm shadow-gray-200">
          <Text className="mb-4 text-lg font-bold text-black">Spending by category</Text>
          {isLoading ? (
            <Text className="text-sm text-gray-500">Loading your transactions…</Text>
          ) : categories.length === 0 ? (
            <Text className="text-sm text-gray-500">No expenses to break down for this month yet.</Text>
          ) : (
            <View className="gap-5">
              {categories.map((category) => {
                const Icon = category.icon;
                const share = totalSpentMinor === 0 ? 0 : category.amountMinor / totalSpentMinor;
                return (
                  <View key={category.name}>
                    <View className="mb-2 flex-row items-center justify-between">
                      <View className="mr-3 flex-1 flex-row items-center">
                        <View className="h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: `${category.color}20` }}>
                          <Icon size={18} color={category.color} />
                        </View>
                        <Text className="ml-3 flex-1 text-base font-semibold text-gray-800" numberOfLines={1}>{category.name}</Text>
                      </View>
                      <View className="items-end">
                        <Text className="font-bold text-gray-900">{formatMinorUnits(category.amountMinor)}</Text>
                        <Text className="mt-0.5 text-xs text-gray-500">{(share * 100).toFixed(0)}% of spending</Text>
                      </View>
                    </View>
                    <View className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                      <View className="h-full rounded-full" style={{ width: `${share * 100}%`, backgroundColor: category.color }} />
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>

        <View className="mb-6 rounded-3xl bg-white p-5 shadow-sm shadow-gray-200">
          <Text className="mb-1 text-lg font-bold text-black">Largest expenses</Text>
          <Text className="mb-4 text-sm text-gray-500">Your highest recorded expenses for {monthLabel}.</Text>
          {largestTransactions.length === 0 ? (
            <Text className="text-sm text-gray-500">No expenses recorded for this month.</Text>
          ) : (
            <View className="gap-4">
              {largestTransactions.map((tx) => {
                const style = CATEGORY_STYLES[tx.category] ?? { color: '#9ca3af', icon: ShoppingCart };
                const Icon = style.icon;
                return (
                  <View key={tx.id} className="flex-row items-center justify-between">
                    <View className="mr-3 flex-1 flex-row items-center">
                      <View className="h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: `${style.color}20` }}>
                        <Icon size={19} color={style.color} />
                      </View>
                      <View className="ml-3 flex-1">
                        <Text className="font-semibold text-gray-800" numberOfLines={1}>{tx.note || tx.category}</Text>
                        <Text className="mt-0.5 text-xs text-gray-500">{tx.category} · {new Date(tx.date).toLocaleDateString()}</Text>
                      </View>
                    </View>
                    <Text className="font-bold text-red-600">− {formatMinorUnits(tx.amountMinor)}</Text>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
