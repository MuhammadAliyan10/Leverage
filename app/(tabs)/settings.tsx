import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Switch, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { useColorScheme } from 'nativewind';
import { Building2, Target, Moon, Coins, CloudSync, FileText, LogOut, Trash2, ChevronRight } from 'lucide-react-native';

interface SettingRowProps {
  icon: any;
  title: string;
  isDanger?: boolean;
  onPress?: () => void;
  rightComponent?: React.ReactNode;
  showChevron?: boolean;
}

const SettingRow: React.FC<SettingRowProps> = ({ 
  icon: Icon, 
  title, 
  isDanger = false, 
  onPress, 
  rightComponent, 
  showChevron = false 
}) => {
  return (
    <TouchableOpacity 
      onPress={onPress}
      className={`flex-row items-center justify-between py-4 border-b border-gray-100 dark:border-neutral-800 active:opacity-70`}
      disabled={!onPress}
    >
      <View className="flex-row items-center">
        <View className={`h-9 w-9 items-center justify-center rounded-full ${isDanger ? 'bg-red-100 dark:bg-red-500/20' : 'bg-primary/10 dark:bg-primary/20'}`}>
          <Icon size={18} color={isDanger ? '#ef4444' : '#533AFE'} />
        </View>
        <Text className={`ml-4 text-base font-semibold ${isDanger ? 'text-red-500' : 'text-gray-900 dark:text-white'}`}>
          {title}
        </Text>
      </View>
      <View className="flex-row items-center">
        {rightComponent}
        {showChevron && <ChevronRight size={20} color="#9ca3af" className="ml-2" />}
      </View>
    </TouchableOpacity>
  );
};

import { useRouter } from 'expo-router';
import { useAuth } from '../../src/context/AuthContext';

export default function SettingsScreen() {
  const { colorScheme, toggleColorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const router = useRouter();
  const { user, signOut } = useAuth();

  const userInitials = user?.fullName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) ?? '?';

  const handleWipeData = () => {
    Alert.alert(
      "Wipe Local Data",
      "Are you sure you want to delete all local data? This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Wipe Data", style: "destructive", onPress: () => console.log("Data wiped") }
      ]
    );
  };

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: () => signOut() }
    ]);
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
      <GlobalHeader 
        title="Settings" 
        description="Manage your app and data" 
      />

      <ScrollView className="flex-1 px-6 pt-4" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>
        
        {/* User Profile Card */}
        <View className="mb-6 flex-row items-center rounded-3xl bg-white dark:bg-neutral-900 p-5">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-primary">
            <Text className="text-2xl font-bold text-white">{userInitials}</Text>
          </View>
          <View className="ml-4 flex-1">
            <Text className="text-xl font-bold text-gray-900 dark:text-white">{user?.fullName ?? '—'}</Text>
            <Text className="text-sm text-gray-500 dark:text-neutral-400 mt-0.5">{user?.email ?? '—'}</Text>
          </View>
        </View>

        <View className="space-y-6">
          
          {/* Financial Management */}
          <View className="rounded-3xl bg-white dark:bg-neutral-900 p-5 shadow-sm shadow-gray-200 dark:shadow-none">
            <Text className="mb-2 text-sm font-bold uppercase tracking-wider text-gray-400 dark:text-neutral-500">Financial Management</Text>
            <SettingRow 
              icon={Building2} 
              title="Manage Accounts" 
              showChevron 
              onPress={() => console.log('Navigate to Manage Accounts')} 
            />
            <SettingRow 
              icon={Target} 
              title="Monthly Budgets" 
              showChevron 
              onPress={() => router.push('/budgets')} 
            />
          </View>

          {/* Preferences */}
          <View className="rounded-3xl bg-white dark:bg-neutral-900 p-5 shadow-sm shadow-gray-200 dark:shadow-none">
            <Text className="mb-2 text-sm font-bold uppercase tracking-wider text-gray-400 dark:text-neutral-500">Preferences</Text>
            <SettingRow 
              icon={Moon} 
              title="Dark Mode" 
              rightComponent={
                <Switch 
                  value={isDark} 
                  onValueChange={toggleColorScheme} 
                  trackColor={{ false: '#d1d5db', true: '#533AFE' }}
                  thumbColor="#ffffff"
                />
              } 
            />
            <SettingRow 
              icon={Coins} 
              title="Currency" 
              rightComponent={
                <Text className="text-base font-bold text-gray-500 dark:text-neutral-400">PKR</Text>
              } 
            />
          </View>

          {/* Data & Sync */}
          <View className="rounded-3xl bg-white dark:bg-neutral-900 p-5 shadow-sm shadow-gray-200 dark:shadow-none">
            <Text className="mb-2 text-sm font-bold uppercase tracking-wider text-gray-400 dark:text-neutral-500">Data & Sync</Text>
            <SettingRow 
              icon={CloudSync} 
              title="Cloud Sync" 
              rightComponent={
                <Text className="text-sm text-gray-500 dark:text-neutral-400">Synced 2 mins ago</Text>
              }
              onPress={() => console.log("Manual Sync Triggered")}
            />
            <SettingRow 
              icon={FileText} 
              title="Export Data" 
              showChevron 
              onPress={() => console.log('Export CSV')} 
            />
          </View>

          {/* Danger Zone */}
          <View className="rounded-3xl bg-white dark:bg-neutral-900 p-5 shadow-sm shadow-gray-200 dark:shadow-none mb-10">
            <Text className="mb-2 text-sm font-bold uppercase tracking-wider text-red-500/70">Danger Zone</Text>
            <SettingRow 
              icon={LogOut} 
              title="Sign Out" 
              isDanger 
              onPress={handleSignOut} 
            />
            <View className="border-b-0">
              <SettingRow 
                icon={Trash2} 
                title="Wipe Local Data" 
                isDanger 
                onPress={handleWipeData} 
              />
            </View>
          </View>
          
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}
