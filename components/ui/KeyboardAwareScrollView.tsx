import type { ComponentProps } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';

type Props = ComponentProps<typeof ScrollView>;

/** Scroll form content into the area left available when the native keyboard opens. */
export function KeyboardAwareScrollView(props: Props) {
  return (
    <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView {...props} />
    </KeyboardAvoidingView>
  );
}
