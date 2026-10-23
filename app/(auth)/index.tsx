import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { Check, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, UserRound, WalletCards } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useLocalSearchParams } from 'expo-router';
import { zodResolver } from '@hookform/resolvers/zod';
import Toast from 'react-native-toast-message';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../src/context/AuthContext';
import {
  signInSchema,
  signUpSchema,
  SignInFormData,
  SignUpFormData,
} from '../../utils/validations/auth';

type Mode = 'signin' | 'signup';

const AUTH_BUTTON_CLASS = 'houselog-button w-full flex-row items-center justify-center py-3.5 active:opacity-90';

export default function AuthScreen() {
  const params = useLocalSearchParams<{ email?: string | string[] }>();
  const [mode, setMode] = useState<Mode>('signin');
  const [rememberMe, setRememberMe] = useState(true);
  const [showSignInPassword, setShowSignInPassword] = useState(false);
  const [showSignUpPassword, setShowSignUpPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const signInPasswordRef = React.useRef<TextInput>(null);
  const signUpEmailRef = React.useRef<TextInput>(null);
  const signUpPasswordRef = React.useRef<TextInput>(null);
  const signUpConfirmRef = React.useRef<TextInput>(null);
  const { signIn, signUp, restoreError, sessionNotice } = useAuth();

  const {
    control: signInControl,
    handleSubmit: handleSignInSubmit,
    formState: { errors: signInErrors, isSubmitting: isSignInSubmitting },
    setError: setSignInError,
    clearErrors: clearSignInErrors,
    setValue: setSignInValue,
  } = useForm<SignInFormData>({
    resolver: zodResolver(signInSchema),
    mode: 'onTouched',
    reValidateMode: 'onChange',
    defaultValues: { email: '', password: '' },
  });

  const {
    control: signUpControl,
    handleSubmit: handleSignUpSubmit,
    formState: { errors: signUpErrors, isSubmitting: isSignUpSubmitting },
    setError: setSignUpError,
    clearErrors: clearSignUpErrors,
    trigger: triggerSignUpValidation,
    getFieldState: getSignUpFieldState,
  } = useForm<SignUpFormData>({
    resolver: zodResolver(signUpSchema),
    mode: 'onTouched',
    reValidateMode: 'onChange',
    defaultValues: { fullName: '', email: '', password: '', confirmPassword: '' },
  });

  const signUpPassword = useWatch({ control: signUpControl, name: 'password' });
  useEffect(() => {
    const email = Array.isArray(params.email) ? params.email[0] : params.email;
    if (email) setSignInValue('email', email, { shouldValidate: true });
  }, [params.email, setSignInValue]);
  useEffect(() => {
    if (getSignUpFieldState('confirmPassword').isTouched) {
      void triggerSignUpValidation('confirmPassword');
    }
  }, [getSignUpFieldState, signUpPassword, triggerSignUpValidation]);

  const onSignIn = async (data: SignInFormData) => {
    let result: { success: boolean; error?: string; passwordUpgradePending?: boolean };
    try {
      result = await signIn(data.email, data.password, rememberMe);
    } catch {
      result = { success: false, error: 'Local sign in could not complete. Check device storage and try again.' };
    }
    if (!result.success) {
      if (result.error?.toLowerCase().includes('email') || result.error?.toLowerCase().includes('account')) {
        setSignInError('email', { message: result.error });
      } else {
        setSignInError('password', { message: result.error });
      }
      Toast.show({ type: 'error', text1: 'Sign In Failed', text2: result.error });
    } else if (result.passwordUpgradePending) {
      Toast.show({ type: 'info', text1: 'Password security update pending', text2: 'Your login was verified; stored password protection could not be upgraded yet.' });
    }
    // The router guard redirects after AuthContext publishes the authenticated user.
  };

  const onSignUp = async (data: SignUpFormData) => {
    let result: { success: boolean; error?: string };
    try {
      result = await signUp(data.fullName, data.email, data.password, rememberMe);
    } catch {
      result = { success: false, error: 'Local account setup could not complete. Check device storage and try again.' };
    }
    if (!result.success) {
      if (result.error?.toLowerCase().includes('email')) {
        setSignUpError('email', { message: result.error });
      } else {
        setSignUpError('root', { message: result.error });
      }
      Toast.show({ type: 'error', text1: 'Sign Up Failed', text2: result.error });
    }
  };

  const switchMode = (next: Mode) => {
    clearSignInErrors();
    clearSignUpErrors();
    setMode(next);
  };

  const fieldIcon = (Icon: typeof Mail) => <Icon size={18} color="#7b8495" />;
  const visibilityAction = (visible: boolean, toggle: () => void, label: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={visible ? `Hide ${label}` : `Show ${label}`}
      hitSlop={10}
      onPress={toggle}
      className="p-1"
    >
      {visible ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}
    </Pressable>
  );

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
      <View pointerEvents="none" className="absolute inset-0 overflow-hidden">
        <View className="absolute -left-12 top-28 h-40 w-40 rounded-full bg-primary/10" />
        <View className="absolute -right-14 bottom-24 h-48 w-48 rounded-full bg-sky-100 dark:bg-sky-950/40" />
        <View className="absolute right-10 top-16 h-5 w-5 rounded-full bg-primary/30" />
      </View>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 28 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View className="w-full max-w-[460px] self-center py-5">
            <View className="mb-7 h-32 items-center justify-center">
              <View className="relative h-24 w-24 items-center justify-center rounded-full bg-primary/10">
                <WalletCards size={46} color={PRIMARY_COLOR} strokeWidth={1.8} />
                <View className="absolute -bottom-4 -right-4 h-10 w-10 items-center justify-center rounded-full border-[3px] border-gray-50 bg-white shadow-md dark:border-neutral-950 dark:bg-neutral-900">
                  <ShieldCheck size={21} color={PRIMARY_COLOR} strokeWidth={2} />
                </View>
              </View>
              <View className="absolute left-[30%] top-5 h-2.5 w-2.5 rounded-full bg-sky-300" />
            </View>

            <Text className="font-heading text-[28px] font-bold tracking-tight text-[#1b2935] dark:text-white">
              {mode === 'signin' ? 'Login' : 'Register'}
            </Text>
            <Text className="font-body mb-5 mt-1 text-sm text-[#66717e] dark:text-neutral-300">
              {mode === 'signin' ? 'Please sign in to continue.' : 'Create your HouseLog account to get started.'}
            </Text>

            {restoreError && (
              <Text accessibilityRole="alert" className="font-body mb-4 rounded-2xl bg-red-50 p-3 text-center text-sm text-red-700">
                {restoreError}
              </Text>
            )}
            {sessionNotice && (
              <Text accessibilityRole="alert" className="font-body mb-4 rounded-2xl bg-blue-50 p-3 text-center text-xs leading-5 text-blue-800">
                {sessionNotice}
              </Text>
            )}

            {mode === 'signin' ? (
              <View className="w-full">
                <Controller
                  control={signInControl}
                  name="email"
                  render={({ field: { onChange, onBlur, value } }) => (
                    <Input
                      label="Email address"
                      placeholder="name@example.com"
                      variant="pill"
                      leadingIcon={fieldIcon(Mail)}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoComplete="email"
                      textContentType="emailAddress"
                      returnKeyType="next"
                      onSubmitEditing={() => signInPasswordRef.current?.focus()}
                      onBlur={onBlur}
                      onChangeText={onChange}
                      value={value}
                      error={signInErrors.email?.message}
                    />
                  )}
                />
                <Controller
                  control={signInControl}
                  name="password"
                  render={({ field: { onChange, onBlur, value } }) => (
                    <Input
                      label="Password"
                      placeholder="Enter your password"
                      variant="pill"
                      leadingIcon={fieldIcon(LockKeyhole)}
                      secureTextEntry={!showSignInPassword}
                      textContentType="password"
                      inputRef={signInPasswordRef}
                      returnKeyType="done"
                      onSubmitEditing={handleSignInSubmit(onSignIn)}
                      onBlur={onBlur}
                      onChangeText={onChange}
                      value={value}
                      error={signInErrors.password?.message}
                      trailingAction={visibilityAction(showSignInPassword, () => setShowSignInPassword((v) => !v), 'password')}
                    />
                  )}
                />
                <RememberMe checked={rememberMe} onToggle={() => setRememberMe((checked) => !checked)} />
                <Button
                  title="Sign in"
                  className={`${AUTH_BUTTON_CLASS} ${isSignInSubmitting ? 'opacity-60' : ''}`}
                  onPress={handleSignInSubmit(onSignIn)}
                  isLoading={isSignInSubmitting}
                />
              </View>
            ) : (
              <View className="w-full">
                <Controller
                  control={signUpControl}
                  name="fullName"
                  render={({ field: { onChange, onBlur, value } }) => (
                    <Input
                      label="Full name"
                      placeholder="Your name"
                      variant="pill"
                      leadingIcon={fieldIcon(UserRound)}
                      autoCapitalize="words"
                      autoComplete="name"
                      textContentType="name"
                      returnKeyType="next"
                      onSubmitEditing={() => signUpEmailRef.current?.focus()}
                      onBlur={onBlur}
                      onChangeText={onChange}
                      value={value}
                      error={signUpErrors.fullName?.message}
                    />
                  )}
                />
                <Controller
                  control={signUpControl}
                  name="email"
                  render={({ field: { onChange, onBlur, value } }) => (
                    <Input
                      label="Email address"
                      placeholder="name@example.com"
                      variant="pill"
                      leadingIcon={fieldIcon(Mail)}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoComplete="email"
                      textContentType="emailAddress"
                      inputRef={signUpEmailRef}
                      returnKeyType="next"
                      onSubmitEditing={() => signUpPasswordRef.current?.focus()}
                      onBlur={onBlur}
                      onChangeText={onChange}
                      value={value}
                      error={signUpErrors.email?.message}
                    />
                  )}
                />
                <Controller
                  control={signUpControl}
                  name="password"
                  render={({ field: { onChange, onBlur, value } }) => (
                    <Input
                      label="Password"
                      placeholder="Create a password"
                      variant="pill"
                      leadingIcon={fieldIcon(LockKeyhole)}
                      helperText="Use 10+ characters, with an uppercase letter and a number."
                      secureTextEntry={!showSignUpPassword}
                      textContentType="newPassword"
                      inputRef={signUpPasswordRef}
                      returnKeyType="next"
                      onSubmitEditing={() => signUpConfirmRef.current?.focus()}
                      onBlur={onBlur}
                      onChangeText={onChange}
                      value={value}
                      error={signUpErrors.password?.message}
                      trailingAction={visibilityAction(showSignUpPassword, () => setShowSignUpPassword((v) => !v), 'password')}
                    />
                  )}
                />
                <Controller
                  control={signUpControl}
                  name="confirmPassword"
                  render={({ field: { onChange, onBlur, value } }) => (
                    <Input
                      label="Confirm password"
                      placeholder="Enter the password again"
                      variant="pill"
                      leadingIcon={fieldIcon(LockKeyhole)}
                      secureTextEntry={!showConfirmPassword}
                      textContentType="newPassword"
                      inputRef={signUpConfirmRef}
                      returnKeyType="done"
                      onSubmitEditing={handleSignUpSubmit(onSignUp)}
                      onBlur={onBlur}
                      onChangeText={onChange}
                      value={value}
                      error={signUpErrors.confirmPassword?.message}
                      trailingAction={visibilityAction(showConfirmPassword, () => setShowConfirmPassword((v) => !v), 'confirmation password')}
                    />
                  )}
                />
                {signUpErrors.root && (
                  <Text accessibilityRole="alert" className="font-body mb-3 text-sm text-red-600">
                    {signUpErrors.root.message}
                  </Text>
                )}
                <RememberMe checked={rememberMe} onToggle={() => setRememberMe((checked) => !checked)} />
                <Button
                  title="Sign up"
                  className={`${AUTH_BUTTON_CLASS} ${isSignUpSubmitting ? 'opacity-60' : ''}`}
                  onPress={handleSignUpSubmit(onSignUp)}
                  isLoading={isSignUpSubmitting}
                />
              </View>
            )}

            <View className="mt-5 flex-row justify-center">
              <Text className="font-body text-sm text-[#8a929d] dark:text-neutral-400">
                {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
              >
                <Text className="font-body text-sm font-semibold text-primary">
                  {mode === 'signin' ? 'Sign up' : 'Sign in'}
                </Text>
              </TouchableOpacity>
            </View>
            <Text className="font-body mt-5 text-center text-xs text-gray-400 dark:text-neutral-500">
              HouseLog keeps your financial records on this device.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function RememberMe({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel="Remember this profile on this device"
      className="mb-5 flex-row items-center self-start"
      onPress={onToggle}
    >
      <View className={`mr-2 h-[18px] w-[18px] items-center justify-center rounded border ${checked ? 'border-primary bg-primary' : 'border-gray-300 bg-white'}`}>
        {checked && <Check size={13} color="#ffffff" strokeWidth={3} />}
      </View>
      <Text className="font-body text-xs text-[#56616f] dark:text-neutral-300">Remember this profile</Text>
    </Pressable>
  );
}
