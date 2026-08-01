import { Tabs } from 'expo-router';
import { View, Platform } from 'react-native';
import { Home, ListOrdered, Plus, PieChart, Settings } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

export default function TabsLayout() {
  return (
    <Tabs
      screenListeners={{
        tabPress: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#533AFE',
        tabBarInactiveTintColor: '#9ca3af',
        tabBarShowLabel: false,
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopWidth: 1,
          borderTopColor: '#f3f4f6',
          height: Platform.OS === 'ios' ? 88 : 68,
          paddingBottom: Platform.OS === 'ios' ? 28 : 8,
          paddingTop: 8,
          elevation: 0,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color, focused }) => (
            <View className={`items-center justify-center pt-1 ${focused ? 'border-t-2 border-primary' : ''}`}>
              <Home size={24} color={color} strokeWidth={focused ? 2.5 : 2} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="transactions"
        options={{
          title: 'Transactions',
          tabBarIcon: ({ color, focused }) => (
            <View className={`items-center justify-center pt-1 ${focused ? 'border-t-2 border-primary' : ''}`}>
              <ListOrdered size={24} color={color} strokeWidth={focused ? 2.5 : 2} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="add"
        options={{
          title: 'Add',
          tabBarIcon: ({ focused }) => (
            <View className="h-14 w-14 items-center justify-center rounded-full bg-primary -mt-6 shadow-md shadow-primary/30">
              <Plus size={28} color="#ffffff" strokeWidth={3} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="insights"
        options={{
          title: 'Insights',
          tabBarIcon: ({ color, focused }) => (
            <View className={`items-center justify-center pt-1 ${focused ? 'border-t-2 border-primary' : ''}`}>
              <PieChart size={24} color={color} strokeWidth={focused ? 2.5 : 2} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, focused }) => (
            <View className={`items-center justify-center pt-1 ${focused ? 'border-t-2 border-primary' : ''}`}>
              <Settings size={24} color={color} strokeWidth={focused ? 2.5 : 2} />
            </View>
          ),
        }}
      />
    </Tabs>
  );
}
