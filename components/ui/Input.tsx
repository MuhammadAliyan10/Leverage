import React, { useState } from 'react';
import { TextInput, View, Text, TextInputProps } from 'react-native';

interface InputProps extends TextInputProps {
  error?: string;
}

export const Input: React.FC<InputProps> = ({ error, ...props }) => {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <View className="mb-4 w-full">
      <TextInput
        className={`w-full rounded-xl border-2 px-4 py-3 text-base text-black bg-white
          ${error ? 'border-red-500' : isFocused ? 'border-primary' : 'border-gray-200'}
        `}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        placeholderTextColor="#9ca3af"
        {...props}
      />
      {error && <Text className="mt-1 text-sm text-red-500">{error}</Text>}
    </View>
  );
};
