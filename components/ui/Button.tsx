import React from 'react';
import { TouchableOpacity, Text, ActivityIndicator, TouchableOpacityProps } from 'react-native';
import * as Haptics from 'expo-haptics';

interface ButtonProps extends TouchableOpacityProps {
  title: string;
  isLoading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({ title, isLoading, disabled, onPress, className, ...props }) => {
  const isDisabled = disabled || isLoading;

  return (
    <TouchableOpacity
      {...props}
      className={`houselog-button w-full flex-row items-center justify-center py-3.5
        ${isDisabled ? 'bg-primary/60' : 'active:bg-primary/90'} ${className ?? ''}
      `}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: Boolean(isLoading) }}
      disabled={isDisabled}
      onPress={(e) => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        onPress?.(e);
      }}
    >
      {isLoading ? (
        <ActivityIndicator color="#ffffff" className="mr-2" />
      ) : null}
      <Text className="font-body text-center text-base font-semibold text-white">
        {title}
      </Text>
    </TouchableOpacity>
  );
};
