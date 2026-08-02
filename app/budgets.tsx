import React, { useState } from 'react';
import { View, Text, ScrollView, TextInput, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlobalHeader } from '../components/ui/GlobalHeader';
import { Button } from '../components/ui/Button';
import { useRouter } from 'expo-router';
import { ShoppingCart, Home, Car, Zap, Coffee } from 'lucide-react-native';

const CATEGORIES = [
  { id: '1', name: 'Groceries', icon: ShoppingCart, defaultLimit: '20000' },
  { id: '2', name: 'Rent & Utilities', icon: Home, defaultLimit: '50000' },
  { id: '3', name: 'Transport', icon: Car, defaultLimit: '15000' },
  { id: '4', name: 'Bills', icon: Zap, defaultLimit: '10000' },
  { id: '5', name: 'Entertainment', icon: Coffee, defaultLimit: '8000' },
];

export default function BudgetsScreen() {
  const router = useRouter();
  const [limits, setLimits] = useState<Record<string, string>>(
    CATEGORIES.reduce((acc, cat) => ({ ...acc, [cat.id]: cat.defaultLimit }), {})
  );

  const handleSave = () => {
    console.log("Saving limits", limits);
    // Persist to localDb logic goes here...
    router.back();
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
      <View className="flex-row items-center px-4 pt-4 pb-2 border-b border-gray-200 dark:border-neutral-800">
        <Pressable onPress={() => router.back()} className="p-2">
          <Text className="text-primary font-bold text-base">Done</Text>
        </Pressable>
        <Text className="flex-1 text-center font-bold text-lg dark:text-white">Monthly Budgets</Text>
        <View className="w-10" />
      </View>

      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <Text className="text-gray-500 dark:text-neutral-400 mb-6">
          Set maximum spending limits for your categories. We'll alert you if you exceed them.
        </Text>

        <View className="space-y-4 mb-10">
          {CATEGORIES.map(cat => {
            const Icon = cat.icon;
            return (
              <View key={cat.id} className="flex-row items-center justify-between rounded-2xl bg-white dark:bg-neutral-900 p-4 shadow-sm shadow-gray-200 dark:shadow-none">
                <View className="flex-row items-center flex-1">
                  <View className="h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                    <Icon size={20} color="#533AFE" />
                  </View>
                  <Text className="ml-3 font-semibold text-gray-900 dark:text-white text-base">{cat.name}</Text>
                </View>
                <View className="flex-row items-center rounded-xl bg-gray-100 dark:bg-neutral-800 px-3 py-2 w-28">
                  <Text className="text-gray-500 dark:text-neutral-400 mr-1 font-bold">₨</Text>
                  <TextInput
                    value={limits[cat.id]}
                    onChangeText={(val) => setLimits(prev => ({ ...prev, [cat.id]: val }))}
                    keyboardType="numeric"
                    className="flex-1 text-black dark:text-white font-bold"
                  />
                </View>
              </View>
            );
          })}
        </View>

      </ScrollView>

      <View className="p-6 bg-white dark:bg-neutral-900 border-t border-gray-200 dark:border-neutral-800">
        <Button title="Save Budgets" onPress={handleSave} />
      </View>
    </SafeAreaView>
  );
}
