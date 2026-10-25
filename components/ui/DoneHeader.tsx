import React from 'react';
import { Pressable, Text, View } from 'react-native';

/** Compact centered title bar used by secondary screens with a Done action. */
export function DoneHeader({ title, onDone }: { title: string; onDone: () => void }) {
  return (
    <View className="flex-row items-center border-b border-gray-200 bg-[#f3f2ff] px-5 py-4 dark:border-neutral-800 dark:bg-neutral-900">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Done and return to the previous screen"
        onPress={onDone}
        className="min-h-11 min-w-10 justify-center"
      >
        <Text className="font-body font-bold text-primary">Done</Text>
      </Pressable>
      <Text numberOfLines={1} accessibilityRole="header" style={{ fontFamily: 'InterBlack' }} className="flex-1 text-center text-xl leading-6 text-gray-900 dark:text-white">
        {title}
      </Text>
      <View className="w-10" />
    </View>
  );
}
