import { Tabs } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Home, ListOrdered, Plus, PieChart, Settings } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../../src/constants/theme';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';

export default function TabsLayout() {
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  // The web screen styling uses NativeWind's `.dark` class. Reading that same
  // source keeps the tab bar in sync even when the OS prefers dark mode.
  const isDark = Platform.OS === 'web'
    ? typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    : colorScheme === 'dark';
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
        tabBarItemStyle: styles.tabItem,
        tabBarButton: ({ ref: _ref, ...props }) => (
          <Pressable {...props} style={[props.style, styles.tabButton]} />
        ),
        tabBarHideOnKeyboard: true,
        tabBarBackground: () => (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: tabBarSurface }]} />
        ),
        tabBarStyle: {
          // BottomTabBar applies the bottom inset as internal padding, so include
          // it in the explicit height to keep the visible controls comfortably tall.
          height: 76 + insets.bottom,
          backgroundColor: tabBarSurface,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: palette.backgroundElement,
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
            <View style={[styles.iconSlot, focused && { backgroundColor: palette.backgroundSelected }]}>
              <Home size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
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
            <View style={[styles.iconSlot, focused && { backgroundColor: palette.backgroundSelected }]}>
              <ListOrdered size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
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
              <Plus size={26} color="#ffffff" strokeWidth={2.5} />
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
            <View style={[styles.iconSlot, focused && { backgroundColor: palette.backgroundSelected }]}>
              <PieChart size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
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
            <View style={[styles.iconSlot, focused && { backgroundColor: palette.backgroundSelected }]}>
              <Settings size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
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
    marginTop: 8,
    marginBottom: 3,
  },
  tabItem: {
    justifyContent: 'center',
  },
  tabButton: {
    justifyContent: 'center',
  },
  iconSlot: {
    width: 36,
    height: 30,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: -9 }],
    elevation: 2,
    shadowColor: PRIMARY_COLOR,
    shadowOpacity: 0.14,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
});
