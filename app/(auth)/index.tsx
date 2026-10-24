import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Image,
  Keyboard,
  TouchableOpacity,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { Check, Eye, EyeOff, LockKeyhole, Mail, UserRound } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { zodResolver } from '@hookform/resolvers/zod';
import Toast from 'react-native-toast-message';
import { getLocalAuthFailureMessage } from '../../src/security/localAuthError';
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
  const router = useRouter();
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
    } catch (error) {
      result = { success: false, error: getLocalAuthFailureMessage(error) };
    }
    if (!result.success) {
      setSignInError('root', {
        type: 'server',
        message: result.error || 'Sign in could not be completed. Check your details and connection, then try again.',
      });
    } else if (result.passwordUpgradePending) {
      Toast.show({ type: 'info', text1: 'Password security update pending', text2: 'Your login was verified; stored password protection could not be upgraded yet.' });
    }
    // The router guard redirects after AuthContext publishes the authenticated user.
  };

  const onSignUp = async (data: SignUpFormData) => {
    let result: { success: boolean; error?: string };
    try {
      result = await signUp(data.fullName, data.email, data.password, rememberMe);
    } catch (error) {
      result = { success: false, error: getLocalAuthFailureMessage(error, 'sign-up') };
    }
    if (!result.success) {
      setSignUpError('root', {
        type: 'server',
        message: result.error || 'Account creation could not be completed. Check your connection and try again.',
      });
    }
  };

  const switchMode = (next: Mode) => {
    Keyboard.dismiss();
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
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-start', paddingHorizontal: 20, paddingVertical: 20 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
        >
          <View className="w-full max-w-[460px] self-center py-5">
            <View className="mb-6 h-24 items-center justify-center">
              <View
                className="relative h-20 w-20 items-center justify-center rounded-full bg-primary/10"
                style={{ width: 80, height: 80, flexGrow: 0, flexShrink: 0 }}
              >
                <Image
                  source={require('../../assets/images/leverage-icon-standard-v2.png')}
                  className="h-16 w-16 rounded-full"
                  style={{ width: 64, height: 64, flexGrow: 0, flexShrink: 0, borderRadius: 32 }}
                  resizeMode="contain"
                  accessibilityLabel="Leverage app logo"
                />
              </View>
            </View>

            <Text className="font-heading text-[28px] font-bold tracking-tight text-[#1b2935] dark:text-white">
              {mode === 'signin' ? 'Login' : 'Register'}
            </Text>
            <Text className="font-body mb-5 mt-1 text-sm text-[#66717e] dark:text-neutral-300">
              {mode === 'signin' ? 'Sign in to your profile on this device.' : 'Create your cloud account. An internet connection is required.'}
            </Text>

            {restoreError && (
              <Text accessibilityRole="alert" className="font-body mb-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-center text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                {restoreError}
              </Text>
            )}
            {sessionNotice && (
              <Text accessibilityRole="alert" className="font-body mb-4 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-center text-xs leading-5 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
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
                      onChangeText={(value) => { onChange(value); clearSignInErrors('root'); }}
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
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={(value) => { onChange(value); clearSignInErrors('root'); }}
                      value={value}
                      error={signInErrors.password?.message}
                      trailingAction={visibilityAction(showSignInPassword, () => setShowSignInPassword((v) => !v), 'password')}
                    />
                  )}
                />
                {signInErrors.root?.message ? (
                  <Text accessibilityRole="alert" className="font-body mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm leading-5 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                    {signInErrors.root.message}
                  </Text>
                ) : null}
                <RememberMe checked={rememberMe} disabled={isSignInSubmitting} onToggle={() => setRememberMe((checked) => !checked)} />
                <Button
                  title={isSignInSubmitting ? 'Signing in…' : 'Sign in'}
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
                      onChangeText={(value) => { onChange(value); clearSignUpErrors('root'); }}
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
                      onChangeText={(value) => { onChange(value); clearSignUpErrors('root'); }}
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
                      helperText="Use at least 12 characters, with an uppercase letter and a number."
                      secureTextEntry={!showSignUpPassword}
                      textContentType="newPassword"
                      inputRef={signUpPasswordRef}
                      returnKeyType="next"
                      onSubmitEditing={() => signUpConfirmRef.current?.focus()}
                      onBlur={onBlur}
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={(value) => { onChange(value); clearSignUpErrors('root'); }}
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
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={(value) => { onChange(value); clearSignUpErrors('root'); }}
                      value={value}
                      error={signUpErrors.confirmPassword?.message}
                      trailingAction={visibilityAction(showConfirmPassword, () => setShowConfirmPassword((v) => !v), 'confirmation password')}
                    />
                  )}
                />
                {signUpErrors.root && (
                  <Text accessibilityRole="alert" className="font-body mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm leading-5 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                    {signUpErrors.root.message}
                  </Text>
                )}
                <RememberMe checked={rememberMe} disabled={isSignUpSubmitting} onToggle={() => setRememberMe((checked) => !checked)} />
                <Button
                  title={isSignUpSubmitting ? 'Creating account…' : 'Sign up'}
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
                accessibilityLabel={mode === 'signin' ? 'Switch to sign up' : 'Switch to sign in'}
                hitSlop={8}
                disabled={isSignInSubmitting || isSignUpSubmitting}
                onPress={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
              >
                <Text className="font-body text-sm font-semibold text-primary">
                  {mode === 'signin' ? 'Sign up' : 'Sign in'}
                </Text>
              </TouchableOpacity>
            </View>
            <Text className="font-body mt-5 text-center text-xs text-gray-400 dark:text-neutral-500">
              Leverage keeps profiles and financial records separately on each device. A browser profile does not automatically sync to Android.
            </Text>
            <TouchableOpacity accessibilityRole="button" onPress={() => router.push('/restore' as never)} className="mt-4 min-h-11 items-center justify-center">
              <Text className="font-body text-sm font-semibold text-primary">Restore an encrypted backup</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function RememberMe({ checked, onToggle, disabled = false }: { checked: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel="Remember this profile on this device"
      className="mb-5 flex-row items-center self-start"
      disabled={disabled}
      hitSlop={6}
      onPress={onToggle}
    >
      <View className={`mr-2 h-[18px] w-[18px] items-center justify-center rounded border ${checked ? 'border-primary bg-primary' : 'border-gray-300 bg-white'}`}>
        {checked && <Check size={13} color="#ffffff" strokeWidth={3} />}
      </View>
      <Text className="font-body text-xs text-[#56616f] dark:text-neutral-300">Remember this profile</Text>
    </Pressable>
  );
}
