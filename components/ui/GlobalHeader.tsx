import React, { ReactNode, useEffect, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import * as Network from 'expo-network';

interface GlobalHeaderProps {
  title: string;
  description?: string;
  onRightPress?: () => void;
  RightIcon?: ReactNode;
}

export const GlobalHeader: React.FC<GlobalHeaderProps> = ({
  title,
  description,
  onRightPress,
  RightIcon,
}) => {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    const checkNetwork = async () => {
      const state = await Network.getNetworkStateAsync();
      setIsOffline(!(state.isConnected && state.isInternetReachable));
    };
    checkNetwork();
  }, []);

  return (
    <View className="flex-row items-center justify-between px-6 pt-12 pb-4 bg-white dark:bg-neutral-950 border-b border-gray-100 dark:border-neutral-900">
      <View className="flex-1 mr-4">
        <View className="flex-row items-center">
          <Text className="font-fargie text-3xl font-bold text-black dark:text-white">{title}</Text>
          {isOffline && (
            <View className="ml-3 rounded-full bg-yellow-100 px-2 py-0.5">
              <Text className="text-xs font-semibold text-yellow-700">Offline</Text>
            </View>
          )}
        </View>
        {description ? (
          <Text className="mt-1 text-sm text-gray-500 dark:text-neutral-400">{description}</Text>
        ) : null}
      </View>

      {(onRightPress || RightIcon) && (
        <Pressable
          onPress={onRightPress}
          className="h-10 w-10 items-center justify-center rounded-full bg-gray-100"
        >
          {RightIcon}
        </Pressable>
      )}
    </View>
  );
};
