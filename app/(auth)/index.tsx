// app/(auth)/index.tsx
import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useForm, Controller } from 'react-hook-form';
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

const ACTIVE_TAB_SHADOW = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.05,
  shadowRadius: 2,
  elevation: 1,
} as const;

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signin');
  const { signIn, signUp } = useAuth();

  const {
    control: signInControl,
    handleSubmit: handleSignInSubmit,
    formState: { errors: signInErrors, isSubmitting: isSignInSubmitting },
    setError: setSignInError,
  } = useForm<SignInFormData>({ resolver: zodResolver(signInSchema) });

  const {
    control: signUpControl,
    handleSubmit: handleSignUpSubmit,
    formState: { errors: signUpErrors, isSubmitting: isSignUpSubmitting },
    setError: setSignUpError,
  } = useForm<SignUpFormData>({ resolver: zodResolver(signUpSchema) });

  const onSignIn = async (data: SignInFormData) => {
    const result = await signIn(data.email, data.password);
    if (!result.success) {
      if (result.error?.toLowerCase().includes('email') || result.error?.toLowerCase().includes('account')) {
        setSignInError('email', { message: result.error });
      } else {
        setSignInError('password', { message: result.error });
      }
      Toast.show({ type: 'error', text1: 'Sign In Failed', text2: result.error });
    }
    // On success, _layout.tsx router guard redirects automatically via useAuth
  };

  const onSignUp = async (data: SignUpFormData) => {
    const result = await signUp(data.fullName, data.email, data.password);
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
    setMode(next);
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View className="mb-10 items-center">
            <View className="h-20 w-20 items-center justify-center rounded-2xl bg-primary mb-4">
              <Text className="text-3xl font-bold text-white">HL</Text>
            </View>
            <Text className="text-3xl font-bold text-black">HouseLog</Text>
            <Text className="mt-2 text-center text-gray-500">
              Your records stay on this device. Cloud sync is not available yet.
            </Text>
          </View>

          {/* Mode Toggle */}
          <View className="mb-6 flex-row rounded-xl bg-gray-100 p-1">
            <TouchableOpacity
              className={`flex-1 items-center rounded-lg py-3 ${mode === 'signin' ? 'bg-white' : ''}`}
              style={mode === 'signin' ? ACTIVE_TAB_SHADOW : undefined}
              onPress={() => switchMode('signin')}
            >
              <Text className={`font-semibold ${mode === 'signin' ? 'text-primary' : 'text-gray-500'}`}>
                Sign In
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              className={`flex-1 items-center rounded-lg py-3 ${mode === 'signup' ? 'bg-white' : ''}`}
              style={mode === 'signup' ? ACTIVE_TAB_SHADOW : undefined}
              onPress={() => switchMode('signup')}
            >
              <Text className={`font-semibold ${mode === 'signup' ? 'text-primary' : 'text-gray-500'}`}>
                Sign Up
              </Text>
            </TouchableOpacity>
          </View>

          {mode === 'signin' ? (
            <View className="w-full">
              <Controller
                control={signInControl}
                name="email"
                render={({ field: { onChange, onBlur, value } }) => (
                  <Input
                    placeholder="Email"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoComplete="email"
                    textContentType="emailAddress"
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
                    placeholder="Password"
                    secureTextEntry
                    textContentType="password"
                    onBlur={onBlur}
                    onChangeText={onChange}
                    value={value}
                    error={signInErrors.password?.message}
                  />
                )}
              />
              <Button
                title="Sign In"
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
                    placeholder="Full Name"
                    autoCapitalize="words"
                    autoComplete="name"
                    textContentType="name"
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
                    placeholder="Email"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoComplete="email"
                    textContentType="emailAddress"
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
                    placeholder="Password (min 8 chars, uppercase & number)"
                    secureTextEntry
                    textContentType="newPassword"
                    onBlur={onBlur}
                    onChangeText={onChange}
                    value={value}
                    error={signUpErrors.password?.message}
                  />
                )}
              />
              <Controller
                control={signUpControl}
                name="confirmPassword"
                render={({ field: { onChange, onBlur, value } }) => (
                  <Input
                    placeholder="Confirm Password"
                    secureTextEntry
                    textContentType="newPassword"
                    onBlur={onBlur}
                    onChangeText={onChange}
                    value={value}
                    error={signUpErrors.confirmPassword?.message}
                  />
                )}
              />
              {signUpErrors.root && (
                <Text className="mb-3 text-center text-sm text-red-500">
                  {signUpErrors.root.message}
                </Text>
              )}
              <Button
                title="Create Account"
                onPress={handleSignUpSubmit(onSignUp)}
                isLoading={isSignUpSubmitting}
              />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
