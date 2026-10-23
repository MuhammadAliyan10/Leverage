import { Tabs } from 'expo-router';
import { Home, ListOrdered, Plus, PieChart, Settings } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, View, useColorScheme as useSystemColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../../src/constants/theme';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import { useAuth } from '../../src/context/AuthContext';

export default function TabsLayout() {
  const { appearance } = useAuth();
  const systemColorScheme = useSystemColorScheme();
  const insets = useSafeAreaInsets();
  // On web, match the theme class NativeWind has actually applied to the page.
  // The browser media query can disagree with the app's rendered theme.
  const isDark = Platform.OS === 'web'
    ? typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    : appearance === 'system'
      ? systemColorScheme === 'dark'
      : appearance === 'dark';
  const palette = Colors[isDark ? 'dark' : 'light'];
  const tabBarSurface = isDark ? '#000000' : '#ffffff';

  return (
    <Tabs
      screenListeners={{
        tabPress: () => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: PRIMARY_COLOR,
        tabBarInactiveTintColor: palette.textSecondary,
        tabBarLabelStyle: styles.label,
        tabBarIconStyle: styles.tabIcon,
        tabBarItemStyle: styles.tabItem,
        tabBarButton: ({ ref: _ref, ...props }) => (
          <Pressable
            {...props}
            style={[
              props.style,
              styles.tabButton,
              props['aria-selected'] && styles.activeTabButton,
            ]}
          />
        ),
        tabBarHideOnKeyboard: true,
        tabBarBackground: () => (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: tabBarSurface }]} />
        ),
        tabBarStyle: {
          // Keep the controls compact while reserving the device safe-area inset.
          height: 64 + insets.bottom,
          backgroundColor: tabBarSurface,
          borderTopWidth: 0,
          elevation: 0,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarLabel: 'Home',
          tabBarAccessibilityLabel: 'Home',
          tabBarIcon: ({ color, focused }) => (
            <View style={styles.iconSlot}>
              <Home size={20} color={color} strokeWidth={focused ? 2.2 : 1.8} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="transactions"
        options={{
          title: 'Transactions',
          tabBarLabel: 'Transactions',
          tabBarAccessibilityLabel: 'Transactions',
          tabBarIcon: ({ color, focused }) => (
            <View style={styles.iconSlot}>
              <ListOrdered size={20} color={color} strokeWidth={focused ? 2.2 : 1.8} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="add"
        options={{
          title: 'Add',
          tabBarLabel: 'Add',
          tabBarAccessibilityLabel: 'Add Transaction',
          tabBarIcon: () => (
            <View
              style={[
                styles.addButton,
                { backgroundColor: PRIMARY_COLOR },
              ]}
            >
              <Plus size={24} color="#ffffff" strokeWidth={2.4} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="insights"
        options={{
          title: 'Insights',
          tabBarLabel: 'Insights',
          tabBarAccessibilityLabel: 'Insights',
          tabBarIcon: ({ color, focused }) => (
            <View style={styles.iconSlot}>
              <PieChart size={20} color={color} strokeWidth={focused ? 2.2 : 1.8} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarLabel: 'Settings',
          tabBarAccessibilityLabel: 'Settings',
          tabBarIcon: ({ color, focused }) => (
            <View style={styles.iconSlot}>
              <Settings size={20} color={color} strokeWidth={focused ? 2.2 : 1.8} />
            </View>
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: {
    fontFamily: 'Figtree',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 0,
    marginBottom: 0,
  },
  tabIcon: {
    marginBottom: -3,
  },
  tabItem: {
    justifyContent: 'center',
  },
  tabButton: {
    justifyContent: 'center',
    borderTopWidth: 2,
    borderTopColor: 'transparent',
  },
  activeTabButton: {
    borderTopColor: PRIMARY_COLOR,
  },
  iconSlot: {
    width: 32,
    height: 28,
    borderRadius: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: -18 }],
    elevation: 2,
    shadowColor: PRIMARY_COLOR,
    shadowOpacity: 0.14,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
});
