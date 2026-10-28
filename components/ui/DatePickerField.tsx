import React, { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { CalendarDays, X } from 'lucide-react-native';
import { DatePickerModal, en, registerTranslation } from 'react-native-paper-dates';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';

registerTranslation('en', en);

interface DatePickerFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
  clearable?: boolean;
  minDate?: Date;
  maxDate?: Date;
}

function parseDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day, 12);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date
    : undefined;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function DatePickerField({
  label,
  value,
  onChangeText,
  placeholder = 'Choose a date',
  accessibilityLabel,
  clearable = false,
  minDate,
  maxDate,
}: DatePickerFieldProps) {
  const [visible, setVisible] = useState(false);
  const { colorScheme } = useColorScheme();
  const isDark = Platform.OS === 'web'
    ? typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    : colorScheme === 'dark';
  const baseTheme = isDark ? MD3DarkTheme : MD3LightTheme;
  const theme = {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      primary: PRIMARY_COLOR,
      primaryContainer: isDark ? '#30296f' : '#efedff',
      onPrimary: '#ffffff',
    },
  };
  const selectedDate = parseDate(value);

  return (
    <PaperProvider theme={theme}>
      <View className="mb-3">
        <Text className="font-body mb-1 text-xs font-semibold text-gray-600 dark:text-neutral-300">{label}</Text>
        <View className="min-h-11 flex-row items-center border border-gray-200 bg-gray-50 px-3 dark:border-neutral-700 dark:bg-neutral-800">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? label}
            accessibilityHint="Opens the calendar date picker"
            onPress={() => setVisible(true)}
            className="min-h-11 flex-1 flex-row items-center"
          >
            <CalendarDays size={18} color={PRIMARY_COLOR} />
            <Text className={`font-body ml-2 flex-1 text-sm ${selectedDate ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-neutral-400'}`}>
              {selectedDate ? selectedDate.toLocaleDateString() : placeholder}
            </Text>
          </Pressable>
          {clearable && value.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Clear ${label.toLowerCase()}`}
              onPress={() => onChangeText('')}
              className="min-h-11 min-w-11 items-center justify-center"
            >
              <X size={17} color={isDark ? '#a3a3a3' : '#6b7280'} />
            </Pressable>
          ) : null}
        </View>
        <DatePickerModal
          locale="en"
          mode="single"
          visible={visible}
          date={selectedDate ?? new Date()}
          label={label}
          saveLabel="Apply date"
          validRange={minDate || maxDate ? { startDate: minDate, endDate: maxDate } : undefined}
          onDismiss={() => setVisible(false)}
          onConfirm={({ date }) => {
            setVisible(false);
            if (date) onChangeText(formatDate(date));
          }}
        />
      </View>
    </PaperProvider>
  );
}
