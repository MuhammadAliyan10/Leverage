// src/context/AuthContext.tsx
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { localDb, DbUser } from '../db/local/client';

const SESSION_KEY = 'houselog_user_id';

type SessionUser = Omit<DbUser, 'passwordHash'>;

interface AuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  restoreError: string | null;
  signIn: (email: string, password: string) => Promise<{ success: boolean; error?: string; passwordUpgradePending?: boolean }>;
  signUp: (fullName: string, email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    async function restoreSession() {
      try {
        const storedId = await SecureStore.getItemAsync(SESSION_KEY);
        if (storedId) {
          const found = await localDb.user.findById(storedId);
          if (found) await localDb.user.claimLegacyData(found.id);
          setUser(found);
        }
      } catch {
        setRestoreError('Local data could not be opened safely. Your saved records were not changed. Retry sign in or contact support.');
      } finally {
        setIsLoading(false);
      }
    }
    restoreSession();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await localDb.user.signIn(email, password);
    if (result.success) {
      await localDb.user.claimLegacyData(result.user.id);
      await SecureStore.setItemAsync(SESSION_KEY, result.user.id);
      queryClient.clear();
      setUser(result.user);
      setRestoreError(null);
      return { success: true, passwordUpgradePending: result.passwordUpgradePending };
    }
    return { success: false, error: result.error };
  }, [queryClient]);

  const signUp = useCallback(async (fullName: string, email: string, password: string) => {
    const result = await localDb.user.register(fullName, email, password);
    if (result.success) {
      await localDb.user.claimLegacyData(result.user.id);
      await SecureStore.setItemAsync(SESSION_KEY, result.user.id);
      queryClient.clear();
      setUser(result.user);
      setRestoreError(null);
      return { success: true };
    }
    return { success: false, error: result.error };
  }, [queryClient]);

  const signOut = useCallback(async () => {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    queryClient.clear();
    setUser(null);
  }, [queryClient]);

  return (
    <AuthContext.Provider value={{ user, isLoading, restoreError, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
