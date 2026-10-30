import React, { ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { X } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type ActionSheetProps = {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

/** Shared bottom sheet for focused create/edit flows throughout the app. */
export function ActionSheet({ visible, title, onClose, children }: ActionSheetProps) {
  const ref = useRef<BottomSheet>(null);
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const maxSheetHeight = useMemo(() => Math.max(240, windowHeight - insets.top - 24), [insets.top, windowHeight]);
  const dark = colorScheme === 'dark';

  useEffect(() => {
    if (visible) ref.current?.snapToIndex(0);
    else ref.current?.close();
  }, [visible]);

  const renderBackdrop = useCallback((props: BottomSheetBackdropProps) => (
    <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" />
  ), []);

  return (
    <BottomSheet
      ref={ref}
      index={-1}
      enableDynamicSizing
      maxDynamicContentSize={maxSheetHeight}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onClose={onClose}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={{ backgroundColor: dark ? '#0a0a0a' : '#f9fafb' }}
      handleIndicatorStyle={{ backgroundColor: dark ? '#737373' : '#9ca3af', width: 40 }}
    >
      <BottomSheetScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} stickyHeaderIndices={[0]} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 0, paddingBottom: Math.max(8, insets.bottom) }}>
        <View className="z-10 -mx-5 flex-row items-center justify-between border-b border-gray-200 bg-gray-50 px-5 pb-3 pt-2 dark:border-neutral-800 dark:bg-neutral-950">
          <Text accessibilityRole="header" className="font-heading text-xl font-bold text-gray-900 dark:text-white">{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Close ${title}`} onPress={onClose} className="min-h-10 min-w-10 items-center justify-center bg-gray-100 dark:bg-neutral-800">
            <X size={19} color={dark ? '#d4d4d4' : '#52525b'} />
          </Pressable>
        </View>
        <View className="pt-4">
        {children}
        </View>
      </BottomSheetScrollView>
    </BottomSheet>
  );
}
