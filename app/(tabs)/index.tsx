import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { Bell, ShoppingCart, Coffee, Car, DollarSign, ArrowLeftRight } from 'lucide-react-native';
import { BarChart } from 'react-native-gifted-charts';
import { useDashboardMetrics } from '../../hooks/queries/useDashboardMetrics';
import { formatMinorUnits } from '../../src/finance/ledger';

type FilterType = 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';
const FILTERS: readonly FilterType[] = ['Daily', 'Weekly', 'Monthly', 'Yearly'];

export default function DashboardScreen() {
  const [filter, setFilter] = useState<FilterType>('Weekly');
  const { data: metrics, isLoading, isError } = useDashboardMetrics();

  const chartData = metrics?.chartData[filter] || [];
  const transactions = metrics?.transactions || [];

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-white items-center justify-center">
        <Text>Loading Dashboard...</Text>
      </SafeAreaView>
    );
  }

  if (isError || !metrics) {
    return (
      <SafeAreaView className="flex-1 bg-white items-center justify-center px-8">
        <Text className="text-center text-base font-semibold text-gray-800">We couldn’t calculate your summary.</Text>
        <Text className="mt-2 text-center text-sm text-gray-500">Your saved records have not been changed. Reopen the app and try again.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white">
      <GlobalHeader 
        title="Dashboard" 
        description="Welcome back" 
        RightIcon={<Bell size={24} color="#000" />}
        onRightPress={() => console.log("Notifications pressed")}
      />
      
      <ScrollView className="flex-1 px-6" showsVerticalScrollIndicator={false}>
        
        {/* Period summary. Account balances belong in the future balance-sheet view. */}
        <View className="mt-2 w-full overflow-hidden rounded-3xl bg-primary p-6 shadow-xl shadow-primary/40 relative">
          <View className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white opacity-10" />
          <View className="absolute -bottom-10 -left-10 h-40 w-40 rounded-full bg-white opacity-5" />
          
          <Text className="text-sm font-medium text-white/80">This month · {metrics?.monthLabel ?? ''}</Text>
          <View className="mt-5 flex-row justify-between">
            <View>
              <Text className="text-xs font-medium text-white/75">Money in</Text>
              <Text className="mt-1 text-xl font-bold text-white">{formatMinorUnits(metrics?.incomeMinor ?? 0)}</Text>
              <Text className="mt-1 text-[10px] text-white/70">PKR accounts · gifts included · opening balances excluded</Text>
            </View>
            <View className="ml-3">
              <Text className="text-xs font-medium text-white/75">Money out</Text>
              <Text className="mt-1 text-xl font-bold text-white">{formatMinorUnits(metrics?.expenseMinor ?? 0)}</Text>
            </View>
          </View>
          <View className="mt-4 border-t border-white/20 pt-3">
            <Text className="text-xs font-medium text-white/75">Net change from recorded money in and out</Text>
            <Text className="mt-1 text-lg font-bold text-white">{formatMinorUnits(metrics?.netMinor ?? 0)}</Text>
          </View>
          <Text className="mt-2 text-[10px] text-white/70">
            {metrics?.excludedCurrencies?.length
              ? `Excluded from PKR totals: ${metrics.excludedCurrencies.join(', ')}`
              : 'PKR only · no other currencies recorded this month'}
          </Text>
        </View>

        {/* Expense Analytics Section */}
        <View className="mt-8 mb-2">
            <Text className="text-xl font-bold text-black mb-1">Spending over time</Text>
          <Text className="text-sm text-gray-500 mb-4">PKR accounts only. Moving money between your own accounts is not spending.</Text>
          
          {/* Segmented Control */}
          <View className="flex-row rounded-xl bg-gray-100 p-1 mb-6">
            {FILTERS.map((tab) => (
              <Pressable
                key={tab}
                className={`flex-1 items-center rounded-lg py-2 ${filter === tab ? 'bg-white shadow-sm' : ''}`}
                onPress={() => setFilter(tab)}
              >
                <Text className={`text-sm font-semibold ${filter === tab ? 'text-primary' : 'text-gray-500'}`}>
                  {tab}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Bar Chart */}
          <View className="w-full bg-white overflow-hidden" style={{ minHeight: 220 }}>
            <BarChart
              data={chartData.map(item => ({
                value: item.value,
                label: item.label,
                frontColor: '#533AFE',
                topLabelComponent: () => (
                  <Text style={{color: '#9ca3af', fontSize: 10, marginBottom: 4}}>{item.value >= 1000 ? `${(item.value/1000).toFixed(1)}k` : item.value}</Text>
                )
              }))}
              barWidth={28}
              spacing={24}
              roundedTop
              roundedBottom
              hideRules
              xAxisThickness={0}
              yAxisThickness={0}
              yAxisTextStyle={{ color: '#9ca3af' }}
              xAxisLabelTextStyle={{ color: '#6b7280', textAlign: 'center' }}
              noOfSections={4}
              initialSpacing={10}
              formatYLabel={(label) => {
                const val = Number(label);
                return val >= 1000 ? `${val/1000}k` : label;
              }}
            />
          </View>
        </View>

        {/* Recent Transactions */}
        <View className="mt-6 mb-10">
          <View className="mb-4 flex-row items-center justify-between">
            <Text className="text-xl font-bold text-black">Recent Activity</Text>
            <Pressable>
              <Text className="text-sm font-semibold text-primary">See All</Text>
            </Pressable>
          </View>

          <View className="space-y-4">
            {transactions.length === 0 ? (
              <Text className="text-gray-500 text-center py-4">No recent activity.</Text>
            ) : (
              transactions.map((tx) => {
                // Determine icon mapping inside UI for now
                const originalType = tx.reversalOfId ? transactions.find((candidate) => candidate.id === tx.reversalOfId)?.type : undefined;
                const isIncome = tx.type === 'Income' || tx.type === 'Refund' || (tx.type === 'Reversal' && originalType === 'Expense');
                const isTransfer = tx.type === 'Transfer' || (tx.type === 'Reversal' && originalType === 'Transfer');
                const Icon = isIncome ? DollarSign : isTransfer ? ArrowLeftRight : ShoppingCart;
                
                return (
                  <View key={tx.id} className="flex-row items-center justify-between rounded-2xl bg-gray-50 p-4">
                    <View className="flex-row items-center">
                      <View className={`h-12 w-12 items-center justify-center rounded-full ${isIncome ? 'bg-green-100' : isTransfer ? 'bg-blue-100' : 'bg-red-100'}`}>
                        <Icon size={24} color={isIncome ? '#16a34a' : isTransfer ? '#2563eb' : '#dc2626'} />
                      </View>
                      <View className="ml-4">
                        <Text className="text-base font-bold text-black">{tx.category}</Text>
                        <Text className="text-xs text-gray-500 mt-1">{new Date(tx.date).toLocaleDateString()}</Text>
                      </View>
                    </View>
                    <Text className={`text-base font-bold ${isIncome ? 'text-green-600' : isTransfer ? 'text-blue-600' : 'text-red-600'}`}>
                      {isIncome ? '+' : isTransfer ? '↔' : '-'} {formatMinorUnits(tx.amountMinor, tx.accountCurrency ?? 'PKR')}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}
