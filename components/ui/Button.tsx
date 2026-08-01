import React from 'react';
import { Pressable, Text, ActivityIndicator, PressableProps } from 'react-native';
import * as Haptics from 'expo-haptics';

interface ButtonProps extends PressableProps {
  title: string;
  isLoading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({ title, isLoading, disabled, ...props }) => {
  const isDisabled = disabled || isLoading;

  return (
    <Pressable
      className={`w-full flex-row items-center justify-center rounded-xl py-3.5 
        ${isDisabled ? 'bg-primary/60' : 'bg-primary active:bg-primary/90'}
      `}
      disabled={isDisabled}
      onPress={(e) => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        if (props.onPress) {
          props.onPress(e);
        }
      }}
      {...props}
    >
      {isLoading ? (
        <ActivityIndicator color="#ffffff" className="mr-2" />
      ) : null}
      <Text className="text-center text-base font-semibold text-white">
        {title}
      </Text>
    </Pressable>
  );
};
