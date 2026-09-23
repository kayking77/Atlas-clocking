import React from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { useTheme } from './theme';

export function Card({ children, style }) {
  const { c } = useTheme();
  return (
    <View style={[{ backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.line, padding: 18 }, style]}>
      {children}
    </View>
  );
}

export function Label({ children, style }) {
  const { c } = useTheme();
  return (
    <Text style={[{ color: c.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase' }, style]}>
      {children}
    </Text>
  );
}

export function Button({ title, onPress, kind = 'primary', busy = false, disabled = false, big = false, style, accessibilityHint }) {
  const { c } = useTheme();
  const palette = {
    primary: { bg: c.accent, fg: c.accentInk, border: c.accent },
    go: { bg: c.on, fg: '#FFFFFF', border: c.on },
    stop: { bg: c.bad, fg: '#FFFFFF', border: c.bad },
    quiet: { bg: 'transparent', fg: c.accent, border: c.line },
  }[kind];
  const off = disabled || busy;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          borderWidth: 1,
          borderRadius: big ? 16 : 10,
          paddingVertical: big ? 20 : 12,
          paddingHorizontal: 18,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 10,
          opacity: off ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={palette.fg} /> : null}
      <Text style={{ color: palette.fg, fontSize: big ? 20 : 16, fontWeight: '700', letterSpacing: big ? 0.3 : 0 }}>{title}</Text>
    </Pressable>
  );
}

export function Pill({ tone = 'neutral', children }) {
  const { c } = useTheme();
  const t = {
    neutral: [c.sunk, c.muted],
    on: [c.onSoft, c.on],
    warn: [c.warnSoft, c.warn],
    bad: [c.badSoft, c.bad],
    accent: [c.accentSoft, c.accent],
  }[tone];
  return (
    <View style={{ backgroundColor: t[0], borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' }}>
      <Text style={{ color: t[1], fontSize: 12, fontWeight: '700' }}>{children}</Text>
    </View>
  );
}

export function Field({ label, style, ...props }) {
  const { c } = useTheme();
  return (
    <View style={[{ gap: 6 }, style]}>
      {label ? <Label>{label}</Label> : null}
      <TextInput
        placeholderTextColor={c.muted}
        style={{
          backgroundColor: c.surface,
          borderColor: c.line,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 16,
          color: c.ink,
        }}
        {...props}
      />
    </View>
  );
}

export function Notice({ tone = 'warn', children }) {
  const { c } = useTheme();
  const t = { warn: [c.warnSoft, c.warn], bad: [c.badSoft, c.bad], on: [c.onSoft, c.on], neutral: [c.sunk, c.ink] }[tone];
  return (
    <View style={{ backgroundColor: t[0], borderRadius: 10, padding: 12 }}>
      <Text style={{ color: t[1], fontSize: 14, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}
