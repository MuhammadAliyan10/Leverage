import React, { useEffect, useState } from 'react';
import { View, Text, Animated } from 'react-native';
import { formatMinorUnits } from '../../src/finance/ledger';

interface BudgetProgressBarProps {
  categoryName: string;
  icon: any;
  spent: number;
  limit: number;
  currency?: string;
}

export const BudgetProgressBar: React.FC<BudgetProgressBarProps> = ({
  categoryName,
  icon: Icon,
  spent,
  limit,
  currency = 'PKR',
}) => {
  const percentage = limit > 0 ? (spent / limit) * 100 : spent > 0 ? 100 : 0;
  const clampedPercentage = Math.max(0, Math.min(percentage, 100));
  const isOverBudget = spent > limit;

  let barColor = 'bg-primary';
  if (percentage >= 75 && percentage <= 90) {
    barColor = 'bg-amber-500';
  } else if (percentage > 90) {
    barColor = 'bg-red-500';
  }

  // Animation for width
  const [animatedWidth] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(animatedWidth, {
      toValue: clampedPercentage,
      duration: 1000,
      useNativeDriver: false, // width doesn't support native driver
    }).start();
  }, [animatedWidth, clampedPercentage]);

  const widthInterpolation = animatedWidth.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <View className="mb-4">
      {/* Top Row */}
      <View className="flex-row items-center justify-between mb-2">
        <View className="flex-row items-center">
          <View className={`h-8 w-8 items-center justify-center rounded-full bg-gray-100 dark:bg-neutral-800`}>
            <Icon size={16} color="#9ca3af" />
          </View>
          <Text className="font-body ml-3 font-semibold text-gray-900 dark:text-white text-base">
            {categoryName}
          </Text>
        </View>
        <Text className={["font-body", (`font-bold text-sm ${isOverBudget ? 'text-red-500' : 'text-gray-600 dark:text-gray-400'}`)].filter(Boolean).join(' ')}>
          {formatMinorUnits(Math.round(spent * 100), currency)} / {formatMinorUnits(Math.round(limit * 100), currency)}
        </Text>
      </View>

      {/* Bottom Row (The Bar) */}
      <View className="h-3 w-full rounded-full bg-gray-100 dark:bg-neutral-800 overflow-hidden">
        <Animated.View 
          className={`h-full rounded-full ${barColor}`}
          style={{ width: widthInterpolation }} 
        />
      </View>
    </View>
  );
};
