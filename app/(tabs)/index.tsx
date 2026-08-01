import React, { useState } from 'react';
import { View, Text, ScrollView, SafeAreaView, Pressable, Platform } from 'react-native';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { Bell, ShoppingCart, Coffee, Car, DollarSign } from 'lucide-react-native';
import { BarChart } from 'react-native-gifted-charts';
import { useDashboardMetrics } from '../../hooks/queries/useDashboardMetrics';

type FilterType = 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';

export default function DashboardScreen() {
  const [filter, setFilter] = useState<FilterType>('Weekly');
  const { data: metrics, isLoading } = useDashboardMetrics();

  const chartData = metrics?.chartData[filter] || [];
  const transactions = metrics?.transactions || [];

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-white items-center justify-center">
        <Text>Loading Dashboard...</Text>
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
        
        {/* Total Balance Card */}
        <View className="mt-2 w-full overflow-hidden rounded-3xl bg-primary p-6 shadow-xl shadow-primary/40 relative">
          {/* Subtle Background Pattern Mock using Absolute Elements */}
          <View className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white opacity-10" />
          <View className="absolute -bottom-10 -left-10 h-40 w-40 rounded-full bg-white opacity-5" />
          
          <Text className="text-sm font-medium text-white/80">Total Balance</Text>
          <Text className="mt-2 text-4xl font-bold tracking-tight text-white">₨ {metrics?.totalBalance?.toLocaleString() || 0}</Text>
          <View className="mt-4 flex-row items-center">
            <View className="rounded-full bg-white/20 px-3 py-1">
              <Text className="text-xs font-semibold text-white">+ ₨ 12,000 this month</Text>
            </View>
          </View>
        </View>

        {/* Expense Analytics Section */}
        <View className="mt-8 mb-2">
          <Text className="text-xl font-bold text-black mb-4">Expense Analytics</Text>
          
          {/* Segmented Control */}
          <View className="flex-row rounded-xl bg-gray-100 p-1 mb-6">
            {(['Daily', 'Weekly', 'Monthly', 'Yearly'] as FilterType[]).map((tab) => (
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
              transactions.map((tx: any) => {
                // Determine icon mapping inside UI for now
                const isIncome = tx.type === 'Income';
                const Icon = isIncome ? DollarSign : ShoppingCart; 
                
                return (
                  <View key={tx.id} className="flex-row items-center justify-between rounded-2xl bg-gray-50 p-4">
                    <View className="flex-row items-center">
                      <View className={`h-12 w-12 items-center justify-center rounded-full ${isIncome ? 'bg-green-100' : 'bg-red-100'}`}>
                        <Icon size={24} color={isIncome ? '#16a34a' : '#dc2626'} />
                      </View>
                      <View className="ml-4">
                        <Text className="text-base font-bold text-black">{tx.category}</Text>
                        <Text className="text-xs text-gray-500 mt-1">{new Date(tx.date).toLocaleDateString()}</Text>
                      </View>
                    </View>
                    <Text className={`text-base font-bold ${isIncome ? 'text-green-600' : 'text-red-600'}`}>
                      {isIncome ? '+' : '-'} ₨ {Math.abs(tx.amount).toLocaleString()}
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
