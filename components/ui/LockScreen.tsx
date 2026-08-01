import React, { useEffect } from 'react';
import { View, Text, SafeAreaView, Pressable } from 'react-native';
import { Lock } from 'lucide-react-native';
import { Button } from './Button';

interface LockScreenProps {
  onUnlock: () => void;
}

export function LockScreen({ onUnlock }: LockScreenProps) {
  useEffect(() => {
    // Attempt unlock on mount
    onUnlock();
  }, [onUnlock]);

  return (
    <SafeAreaView className="flex-1 bg-white items-center justify-center dark:bg-neutral-950 px-6 absolute inset-0 z-50">
      <View className="items-center">
        <View className="h-20 w-20 items-center justify-center rounded-full bg-primary/10 mb-6">
          <Lock size={40} color="#533AFE" />
        </View>
        <Text className="text-2xl font-bold text-gray-900 dark:text-white mb-2">App Locked</Text>
        <Text className="text-center text-gray-500 dark:text-neutral-400 mb-10">
          Please authenticate to view your financial data.
        </Text>
        <Button title="Unlock" onPress={onUnlock} className="w-full px-12" />
      </View>
    </SafeAreaView>
  );
}
