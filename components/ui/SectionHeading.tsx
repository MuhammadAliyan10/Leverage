import React from 'react';
import { Pressable, Text, View } from 'react-native';

type SectionHeadingProps = {
  title: string;
  description?: string;
  action?: string;
  onAction?: () => void;
  className?: string;
  size?: 'regular' | 'compact';
};

/** Shared hierarchy for named content sections across the app. */
export function SectionHeading({
  title,
  description,
  action,
  onAction,
  className = '',
  size = 'regular',
}: SectionHeadingProps) {
  return (
    <View className={`flex-row items-center justify-between ${className}`}>
      <View className="min-w-0 flex-1 pr-2">
        <Text
          accessibilityRole="header"
          className={`text-gray-900 dark:text-white ${size === 'regular' ? 'text-lg leading-6' : 'text-base leading-5'}`}
          style={{ fontFamily: 'InterBlack' }}
        >
          {title}
        </Text>
        {description ? (
          <Text className="mt-1 font-body text-xs leading-4 text-gray-500 dark:text-neutral-400">
            {description}
          </Text>
        ) : null}
      </View>
      {action && onAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action}
          onPress={onAction}
          className="min-h-11 justify-center pl-2"
        >
          <View className="border-b border-primary pb-0.5">
            <Text className="font-body text-sm font-semibold text-primary">{action}</Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}
