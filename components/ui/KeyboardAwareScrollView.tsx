import { useEffect, useRef } from 'react';
import type { ComponentProps } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, View, type FocusEvent } from 'react-native';

type Props = ComponentProps<typeof ScrollView> & { fitContent?: boolean };

/** Scroll form content into the area left available when the native keyboard opens. */
export function KeyboardAwareScrollView({ fitContent = false, ...props }: Props) {
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
    <KeyboardAvoidingView className={fitContent ? undefined : 'flex-1'} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View className={fitContent ? 'shrink' : 'flex-1'} onFocus={handleFocusCapture}>
        <ScrollView
          {...props}
          style={fitContent ? [{ flexGrow: 0, flexShrink: 1 }, props.style] : props.style}
          ref={scrollRef}
          keyboardShouldPersistTaps={props.keyboardShouldPersistTaps ?? 'handled'}
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios' ? true : props.automaticallyAdjustKeyboardInsets}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
