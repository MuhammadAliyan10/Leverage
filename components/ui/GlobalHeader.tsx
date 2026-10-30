import React, { ReactNode } from 'react';
import { View, Text, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface GlobalHeaderProps {
  title: string;
  description?: string;
  onLeftPress?: () => void;
  LeftIcon?: ReactNode;
  leftActionLabel?: string;
  onRightPress?: () => void;
  RightIcon?: ReactNode;
  rightActionLabel?: string;
}

export const GlobalHeader: React.FC<GlobalHeaderProps> = ({
  title,
  description,
  onLeftPress,
  LeftIcon,
  leftActionLabel,
  onRightPress,
  RightIcon,
  rightActionLabel,
}) => {
  return (
    <SafeAreaView edges={['top']} className="bg-[#f3f2ff] dark:bg-neutral-900">
      <View className="flex-row items-center justify-between border-b border-gray-200 bg-[#f3f2ff] px-6 pt-3 pb-3 dark:border-neutral-800 dark:bg-neutral-900">
        {onLeftPress && LeftIcon ? (
          <Pressable
            onPress={onLeftPress}
            accessibilityRole="button"
            accessibilityLabel={leftActionLabel ?? 'Back'}
            className="mr-3 h-11 w-11 items-center justify-center rounded-full bg-gray-100 dark:bg-neutral-800"
          >
            {LeftIcon}
          </Pressable>
        ) : null}
        <View className="flex-1 mr-4">
          <View className="flex-row items-center">
            <Text style={{ fontFamily: 'InterBlack' }} className="text-xl leading-6 text-black dark:text-white">{title}</Text>
          </View>
          {description ? (
            <Text className="font-body mt-0 text-xs leading-4 text-gray-500 dark:text-neutral-400">{description}</Text>
          ) : null}
        </View>

        {onRightPress && RightIcon ? (
          <Pressable
            onPress={onRightPress}
            accessibilityRole="button"
            accessibilityLabel={rightActionLabel ?? title}
            className="h-11 w-11 items-center justify-center rounded-full bg-gray-100 dark:bg-neutral-800"
          >
            {RightIcon}
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
};
