import React, { useState } from 'react';
import { TextInput, View, Text, TextInputProps } from 'react-native';

interface InputProps extends TextInputProps {
  label: string;
  error?: string;
  helperText?: string;
  leadingIcon?: React.ReactNode;
  trailingAction?: React.ReactNode;
  variant?: 'default' | 'pill';
  inputRef?: React.Ref<TextInput>;
}

export const Input: React.FC<InputProps> = ({ label, error, helperText, leadingIcon, trailingAction, variant = 'default', style, onFocus, onBlur, inputRef, ...props }) => {
  const [isFocused, setIsFocused] = useState(false);
  const isPill = variant === 'pill';

  return (
    <View className="mb-4 w-full">
      <Text className="font-body mb-1.5 text-sm font-semibold text-gray-700 dark:text-neutral-200">{label}</Text>
      <View className={`w-full flex-row items-center ${isPill ? 'rounded-full border px-4' : 'rounded-xl border-2 px-4'}
        ${isFocused ? 'bg-primary/5' : isPill ? 'bg-gray-100 dark:bg-neutral-800' : 'bg-white dark:bg-neutral-900'}
        ${error ? 'border-red-500' : isPill ? 'border-transparent' : 'border-gray-200'}
      `}>
        {leadingIcon}
        <TextInput
          ref={inputRef}
          className={["font-body", (`min-w-0 flex-1 py-3 text-base text-black dark:text-white ${leadingIcon ? 'pl-3' : ''}`)].filter(Boolean).join(' ')}
          // React Native Web's browser-default focus outline is separate from
          // the wrapper border. Zeroing its width keeps focus visible through
          // the wrapper background without drawing a second box.
          style={[style, { outlineWidth: 0, outlineColor: 'transparent' }]}
          underlineColorAndroid="transparent"
          onFocus={(event) => {
            setIsFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setIsFocused(false);
            onBlur?.(event);
          }}
          placeholderTextColor="#9ca3af"
          accessibilityLabel={label}
          accessibilityHint={error ? `Error: ${error}` : helperText}
          {...props}
        />
        {trailingAction}
      </View>
      {!error && helperText && <Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{helperText}</Text>}
      {error && <Text className="font-body mt-1 text-sm text-red-500">{error}</Text>}
    </View>
  );
};
