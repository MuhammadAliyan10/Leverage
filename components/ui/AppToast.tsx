import React from 'react';
import { Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { AlertTriangle, CheckCircle2, CircleAlert } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import type { ToastConfigParams } from 'react-native-toast-message';

type ToastVariant = 'success' | 'warning' | 'error' | 'info';
type AppToastProps = ToastConfigParams<unknown> & { variant: ToastVariant };
type ToastColors = { accent: string; lightBackground: string; darkBackground: string; lightBorder: string; darkBorder: string; lightText: string; darkText: string };

const palette: Record<ToastVariant, ToastColors> = {
  success: { accent: '#15803d', lightBackground: '#ecfdf3', darkBackground: '#153522', lightBorder: '#bbf7d0', darkBorder: '#28633d', lightText: '#14532d', darkText: '#dcfce7' },
  warning: { accent: '#c2410c', lightBackground: '#fff7ed', darkBackground: '#3b2717', lightBorder: '#fed7aa', darkBorder: '#75431f', lightText: '#7c2d12', darkText: '#ffedd5' },
  error: { accent: '#b91c1c', lightBackground: '#fef2f2', darkBackground: '#3d2024', lightBorder: '#fecaca', darkBorder: '#74343c', lightText: '#7f1d1d', darkText: '#fee2e2' },
  info: { accent: '#c2410c', lightBackground: '#fff7ed', darkBackground: '#3b2717', lightBorder: '#fed7aa', darkBorder: '#75431f', lightText: '#7c2d12', darkText: '#ffedd5' },
};

export function AppToast({ variant, text1, text2, onPress }: AppToastProps) {
  const { width: screenWidth } = useWindowDimensions();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const colors = palette[variant];
  const StatusIcon = variant === 'success' ? CheckCircle2 : variant === 'error' ? CircleAlert : AlertTriangle;
  const message = text2?.trim() || text1?.trim() || '';

  return (
    <TouchableOpacity
      activeOpacity={0.92}
      onPress={onPress}
      accessibilityLabel={message}
      style={{
        width: Math.min(Math.max(0, screenWidth - 32), 520),
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 11,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: isDark ? colors.darkBorder : colors.lightBorder,
        backgroundColor: isDark ? colors.darkBackground : colors.lightBackground,
        shadowColor: '#000000',
        shadowOpacity: isDark ? 0.26 : 0.12,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
      }}
    >
      <View style={{
        width: 32,
        height: 32,
        marginRight: 12,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: isDark ? `${colors.accent}26` : `${colors.accent}14`,
      }}>
        <StatusIcon size={19} color={colors.accent} strokeWidth={2.2} />
      </View>
      <Text
        numberOfLines={2}
        ellipsizeMode="tail"
        style={{
          flex: 1,
          flexShrink: 1,
          color: isDark ? colors.darkText : colors.lightText,
          fontSize: 14,
          lineHeight: 19,
          fontWeight: '600',
        }}
      >
        {message}
      </Text>
    </TouchableOpacity>
  );
}
