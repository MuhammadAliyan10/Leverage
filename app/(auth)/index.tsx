import React, { useState } from 'react';
import { View, Text, Pressable, KeyboardAvoidingView, Platform, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { signInSchema, signUpSchema, SignInFormData, SignUpFormData } from '../../utils/validations/auth';

type Mode = 'signin' | 'signup';

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signin');

  const {
    control: signInControl,
    handleSubmit: handleSignInSubmit,
    formState: { errors: signInErrors, isSubmitting: isSignInSubmitting },
  } = useForm<SignInFormData>({
    resolver: zodResolver(signInSchema),
  });

  const {
    control: signUpControl,
    handleSubmit: handleSignUpSubmit,
    formState: { errors: signUpErrors, isSubmitting: isSignUpSubmitting },
  } = useForm<SignUpFormData>({
    resolver: zodResolver(signUpSchema),
  });

  const router = useRouter();

  const onSignIn = (data: SignInFormData) => {
    console.log('Sign In Data:', data);
    router.replace('/(tabs)');
  };

  const onSignUp = (data: SignUpFormData) => {
    console.log('Sign Up Data:', data);
    router.replace('/(tabs)');
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-center px-6"
      >
        <View className="mb-10 items-center">
          <View className="h-20 w-20 items-center justify-center rounded-2xl bg-primary mb-4">
            <Text className="text-3xl font-bold text-white">HL</Text>
          </View>
          <Text className="font-fargie text-3xl font-bold text-black">HouseLog</Text>
          <Text className="mt-2 text-center text-gray-500">Manage your finances offline and sync seamlessly to the cloud.</Text>
        </View>

        <View className="mb-6 flex-row rounded-xl bg-gray-100 p-1">
          <Pressable
            className={`flex-1 items-center rounded-lg py-3 ${mode === 'signin' ? 'bg-white shadow-sm' : ''}`}
            onPress={() => setMode('signin')}
          >
            <Text className={`font-semibold ${mode === 'signin' ? 'text-primary' : 'text-gray-500'}`}>Sign In</Text>
          </Pressable>
          <Pressable
            className={`flex-1 items-center rounded-lg py-3 ${mode === 'signup' ? 'bg-white shadow-sm' : ''}`}
            onPress={() => setMode('signup')}
          >
            <Text className={`font-semibold ${mode === 'signup' ? 'text-primary' : 'text-gray-500'}`}>Sign Up</Text>
          </Pressable>
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
                  placeholder="Password"
                  secureTextEntry
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={value}
                  error={signUpErrors.password?.message}
                />
              )}
            />
            <Button
              title="Create Account"
              onPress={handleSignUpSubmit(onSignUp)}
              isLoading={isSignUpSubmitting}
            />
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
