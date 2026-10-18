// src/context/AuthContext.tsx
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import { localDb, DbUser } from '../db/local/client';

const SESSION_KEY = 'houselog_user_id';

type SessionUser = Omit<DbUser, 'passwordHash'>;

interface AuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signUp: (fullName: string, email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
        // Session restore failure is non-fatal — user will see auth screen
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
      setUser(result.user);
      return { success: true };
    }
    return { success: false, error: result.error };
  }, []);

  const signUp = useCallback(async (fullName: string, email: string, password: string) => {
    const result = await localDb.user.register(fullName, email, password);
    if (result.success) {
      await localDb.user.claimLegacyData(result.user.id);
      await SecureStore.setItemAsync(SESSION_KEY, result.user.id);
      setUser(result.user);
      return { success: true };
    }
    return { success: false, error: result.error };
  }, []);

  const signOut = useCallback(async () => {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
