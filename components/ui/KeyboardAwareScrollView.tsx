import { useEffect, useRef } from 'react';
import type { ComponentProps } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, View, type FocusEvent } from 'react-native';

type Props = ComponentProps<typeof ScrollView>;

/** Scroll form content into the area left available when the native keyboard opens. */
export function KeyboardAwareScrollView(props: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const focusedInputRef = useRef<number | null>(null);

  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      const target = focusedInputRef.current;
      if (target === null) return;
      setTimeout(() => {
        scrollRef.current?.scrollResponderScrollNativeHandleToKeyboard(target, 24, true);
      }, 50);
    });
    return () => subscription.remove();
  }, []);

  const handleFocusCapture = (event: FocusEvent) => {
    focusedInputRef.current = typeof event.nativeEvent.target === 'number' ? event.nativeEvent.target : null;
  };

  return (
    <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View className="flex-1" onFocus={handleFocusCapture}>
        <ScrollView
          {...props}
          ref={scrollRef}
          keyboardShouldPersistTaps={props.keyboardShouldPersistTaps ?? 'handled'}
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios' ? true : props.automaticallyAdjustKeyboardInsets}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
