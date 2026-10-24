import React, { useEffect, useState } from 'react';
import { View, Text, Animated } from 'react-native';

interface BudgetProgressBarProps {
  spent: number;
  limit: number;
}

export const BudgetProgressBar: React.FC<BudgetProgressBarProps> = ({
  spent,
  limit,
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
    <View>
      <View className="mb-1.5 flex-row justify-end">
        <Text className={`font-body text-[10px] font-semibold ${isOverBudget ? 'text-red-600 dark:text-red-400' : percentage >= 75 ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-neutral-400'}`}>
          {isOverBudget ? `${Math.round(percentage)}% · over limit` : `${Math.round(percentage)}% used`}
        </Text>
      </View>
      <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: clampedPercentage, text: `${Math.round(percentage)} percent used` }} className="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800">
        <Animated.View 
          className={`h-full rounded-full ${barColor}`}
          style={{ width: widthInterpolation }} 
        />
      </View>
    </View>
  );
};
