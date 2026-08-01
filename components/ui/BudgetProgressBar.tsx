import React, { useEffect, useRef } from 'react';
import { View, Text, Animated } from 'react-native';

interface BudgetProgressBarProps {
  categoryName: string;
  icon: any;
  spent: number;
  limit: number;
}

export const BudgetProgressBar: React.FC<BudgetProgressBarProps> = ({
  categoryName,
  icon: Icon,
  spent,
  limit,
}) => {
  const percentage = (spent / limit) * 100;
  const clampedPercentage = Math.min(percentage, 100);
  const isOverBudget = spent > limit;

  let barColor = 'bg-[#533AFE]'; // Primary
  if (percentage >= 75 && percentage <= 90) {
    barColor = 'bg-amber-500';
  } else if (percentage > 90) {
    barColor = 'bg-red-500';
  }

  // Animation for width
  const animatedWidth = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(animatedWidth, {
      toValue: clampedPercentage,
      duration: 1000,
      useNativeDriver: false, // width doesn't support native driver
    }).start();
  }, [clampedPercentage]);

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
          <Text className="ml-3 font-semibold text-gray-900 dark:text-white text-base">
            {categoryName}
          </Text>
        </View>
        <Text className={`font-bold text-sm ${isOverBudget ? 'text-red-500' : 'text-gray-600 dark:text-gray-400'}`}>
          ₨ {spent.toLocaleString()} / ₨ {limit.toLocaleString()}
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
