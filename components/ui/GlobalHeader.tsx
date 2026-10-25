import React, { ReactNode } from 'react';
import { View, Text, Pressable } from 'react-native';
import * as Network from 'expo-network';

interface GlobalHeaderProps {
  title: string;
  description?: string;
  onRightPress?: () => void;
  RightIcon?: ReactNode;
  rightActionLabel?: string;
}

export const GlobalHeader: React.FC<GlobalHeaderProps> = ({
  title,
  description,
  onRightPress,
  RightIcon,
  rightActionLabel,
}) => {
  const networkState = Network.useNetworkState();
  const isOffline = networkState.isConnected === false || networkState.isInternetReachable === false;

  return (
    <View className="flex-row items-center justify-between border-b border-gray-200 bg-[#f3f2ff] px-6 pt-3 pb-3 dark:border-neutral-800 dark:bg-neutral-900">
      <View className="flex-1 mr-4">
        <View className="flex-row items-center">
          <Text style={{ fontFamily: 'InterBlack' }} className="text-xl leading-6 text-black dark:text-white">{title}</Text>
          {isOffline && (
            <View className="ml-3 rounded-full bg-yellow-100 px-2 py-0.5">
              <Text className="font-body text-xs font-semibold text-yellow-700">Offline</Text>
            </View>
          )}
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
  );
};
