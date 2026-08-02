import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { ChevronLeft, ChevronRight, ShoppingCart, Home, Car, Zap, Coffee, AlertCircle } from 'lucide-react-native';
import { PieChart } from 'react-native-gifted-charts';
import { BudgetProgressBar } from '../../components/ui/BudgetProgressBar';

interface CategoryData {
  id: string;
  name: string;
  amount: number;
  color: string;
  icon: any;
  limit: number;
}

interface Transaction {
  id: string;
  title: string;
  category: string;
  amount: number;
  date: string;
  icon: any;
}

const CATEGORY_DATA: CategoryData[] = [
  { id: '1', name: 'Groceries', amount: 35000, color: '#533AFE', icon: ShoppingCart, limit: 30000 }, // Over limit
  { id: '2', name: 'Rent & Utilities', amount: 25000, color: '#7b61ff', icon: Home, limit: 50000 },
  { id: '3', name: 'Transport', amount: 12000, color: '#a08bff', icon: Car, limit: 15000 },
  { id: '4', name: 'Bills', amount: 8000, color: '#c5b5ff', icon: Zap, limit: 10000 },
  { id: '5', name: 'Entertainment', amount: 5000, color: '#e0d8ff', icon: Coffee, limit: 8000 },
];

const LARGEST_TRANSACTIONS: Transaction[] = [
  { id: 't1', title: 'Car Repair', category: 'Transport', amount: 15000, date: 'Aug 12', icon: Car },
  { id: 't2', title: 'Imtiaz Super Market', category: 'Groceries', amount: 12500, date: 'Aug 04', icon: ShoppingCart },
  { id: 't3', title: 'Electricity Bill', category: 'Bills', amount: 8000, date: 'Aug 02', icon: Zap },
];

const BUDGET_DATA = [
  { id: 'b1', category: 'Groceries', spent: 15000, limit: 20000, icon: ShoppingCart },
  { id: 'b2', category: 'Transport', spent: 9500, limit: 10000, icon: Car },
  { id: 'b3', category: 'Dining Out', spent: 12000, limit: 10000, icon: Coffee },
];

export default function InsightsScreen() {
  const [currentMonth, setCurrentMonth] = useState('August 2026');

  const totalSpent = CATEGORY_DATA.reduce((sum, item) => sum + item.amount, 0);

  // Sort categories by highest amount
  const sortedCategories = [...CATEGORY_DATA].sort((a, b) => b.amount - a.amount);

  const pieData = sortedCategories.map(cat => ({
    value: cat.amount,
    color: cat.color,
  }));

  return (
    <SafeAreaView className="flex-1 bg-gray-50">
      <GlobalHeader 
        title="Insights" 
        description="Analyze your spending" 
      />

      <ScrollView className="flex-1 px-6 pt-4" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        
        {/* Month Selector */}
        <View className="mb-6 flex-row items-center justify-between rounded-2xl bg-white p-4 shadow-sm shadow-gray-200">
          <Pressable className="h-8 w-8 items-center justify-center rounded-full bg-gray-100 active:bg-gray-200">
            <ChevronLeft size={20} color="#374151" />
          </Pressable>
          <Text className="text-lg font-bold text-gray-800">{currentMonth}</Text>
          <Pressable className="h-8 w-8 items-center justify-center rounded-full bg-gray-100 active:bg-gray-200">
            <ChevronRight size={20} color="#374151" />
          </Pressable>
        </View>

        {/* Donut Chart Section */}
        <View className="mb-6 items-center justify-center rounded-3xl bg-white dark:bg-neutral-900 py-8 shadow-sm shadow-gray-200 dark:shadow-none">
          <PieChart
            donut
            innerRadius={80}
            radius={110}
            data={pieData}
            centerLabelComponent={() => {
              return (
                <View className="items-center justify-center">
                  <Text className="text-sm font-semibold text-gray-500 mb-1">Spent</Text>
                  <Text className="text-2xl font-bold text-black dark:text-white">₨ {totalSpent.toLocaleString()}</Text>
                </View>
              );
            }}
          />
        </View>

        {/* Monthly Budgets */}
        <View className="mb-8 rounded-3xl bg-white dark:bg-neutral-900 p-5 shadow-sm shadow-gray-200 dark:shadow-none">
          <Text className="mb-4 text-lg font-bold text-black dark:text-white">Monthly Budgets</Text>
          <View className="space-y-4">
            {BUDGET_DATA.map(budget => (
              <BudgetProgressBar 
                key={budget.id}
                categoryName={budget.category}
                icon={budget.icon}
                spent={budget.spent}
                limit={budget.limit}
              />
            ))}
          </View>
        </View>

        {/* Category Breakdown List */}
        <View className="mb-8 rounded-3xl bg-white dark:bg-neutral-900 p-5 shadow-sm shadow-gray-200 dark:shadow-none">
          <Text className="mb-4 text-lg font-bold text-black">Spending by Category</Text>
          <View className="space-y-4">
            {sortedCategories.map((cat) => {
              const Icon = cat.icon;
              const percentage = ((cat.amount / totalSpent) * 100).toFixed(0);
              const budgetUsed = Math.min((cat.amount / cat.limit) * 100, 100);
              const isOverBudget = cat.amount > cat.limit;

              return (
                <View key={cat.id} className="mb-2">
                  <View className="flex-row items-center justify-between mb-2">
                    <View className="flex-row items-center flex-1">
                      <View 
                        className="h-10 w-10 items-center justify-center rounded-full" 
                        style={{ backgroundColor: `${cat.color}20` }}
                      >
                        <Icon size={20} color={cat.color} />
                      </View>
                      <Text className="ml-3 text-base font-bold text-gray-800 flex-1" numberOfLines={1}>{cat.name}</Text>
                    </View>
                    <View className="items-end">
                      <Text className={`text-base font-bold ${isOverBudget ? 'text-red-500' : 'text-gray-900'}`}>
                        ₨ {cat.amount.toLocaleString()}
                      </Text>
                      <Text className="text-xs font-semibold text-gray-500 mt-0.5">{percentage}% of Total</Text>
                    </View>
                  </View>
                  
                  {/* Budget Progress Bar */}
                  <View className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden mt-1">
                    <View 
                      className={`h-full rounded-full ${isOverBudget ? 'bg-red-500' : ''}`}
                      style={{ 
                        width: `${budgetUsed}%`,
                        backgroundColor: isOverBudget ? undefined : cat.color 
                      }} 
                    />
                  </View>
                  <Text className="text-xs text-gray-400 text-right mt-1">
                    Limit: ₨ {cat.limit.toLocaleString()}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* Top Biggest Expenses */}
        <View className="mb-6 rounded-3xl bg-white p-5 shadow-sm shadow-gray-200">
          <View className="mb-4 flex-row items-center justify-between">
            <Text className="text-lg font-bold text-black">Largest Transactions</Text>
            <AlertCircle size={18} color="#9ca3af" />
          </View>
          
          <View className="space-y-4">
            {LARGEST_TRANSACTIONS.map((tx) => {
              const Icon = tx.icon;
              return (
                <View key={tx.id} className="flex-row items-center justify-between">
                  <View className="flex-row items-center flex-1">
                    <View className="h-10 w-10 items-center justify-center rounded-full bg-red-100">
                      <Icon size={20} color="#dc2626" />
                    </View>
                    <View className="ml-3 flex-1">
                      <Text className="text-base font-bold text-gray-800" numberOfLines={1}>{tx.title}</Text>
                      <Text className="text-xs text-gray-500 mt-0.5">{tx.date}</Text>
                    </View>
                  </View>
                  <Text className="text-base font-bold text-red-600">- ₨ {Math.abs(tx.amount).toLocaleString()}</Text>
                </View>
              );
            })}
          </View>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}
