import React, { useCallback, useRef, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

export interface AppConfirmationOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/** One branded, accessible confirmation dialog for web and native consequential actions. */
export function useAppConfirm() {
  const [options, setOptions] = useState<AppConfirmationOptions | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);

  const confirm = useCallback((next: AppConfirmationOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOptions(next);
  }), []);

  const settle = useCallback((confirmed: boolean) => {
    setOptions(null);
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(confirmed);
  }, []);

  const dialog = <Modal visible={options !== null} transparent animationType="fade" onRequestClose={() => settle(false)}>
    <View className="flex-1 items-center justify-center px-6">
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss confirmation" onPress={() => settle(false)} className="absolute inset-0 bg-black/50" />
      {options && <View accessibilityViewIsModal className="w-full max-w-[420px] rounded-md border border-gray-100 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
        <Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">{options.title}</Text>
        <Text className="font-body mt-2 text-sm leading-5 text-gray-600 dark:text-neutral-300">{options.message}</Text>
        <View className="mt-5 flex-row justify-end gap-3">
          <Pressable accessibilityRole="button" onPress={() => settle(false)} className="min-h-11 min-w-24 items-center justify-center border border-gray-200 px-4 dark:border-neutral-700"><Text className="font-body font-semibold text-gray-700 dark:text-neutral-200">{options.cancelLabel ?? 'Cancel'}</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => settle(true)} className={`min-h-11 min-w-28 items-center justify-center px-4 ${options.destructive ? 'bg-red-600' : 'houselog-button'}`}><Text className="font-body font-semibold text-white">{options.confirmLabel ?? 'Continue'}</Text></Pressable>
        </View>
      </View>}
    </View>
  </Modal>;

  return { confirm, dialog };
}
