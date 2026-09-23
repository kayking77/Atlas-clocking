import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { supabase, readError, isConfigured } from '../lib/supabase';
import { useTheme } from '../theme';
import { Button, Field, Notice } from '../ui';

export default function LoginScreen() {
  const { c } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signIn() {
    setError('');
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) setError(readError(err).message);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, gap: 28 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.ink, fontSize: 34, fontWeight: '800', letterSpacing: 4 }}>ATLAS</Text>
          <Text style={{ color: c.muted, fontSize: 16 }}>Timeclock for Atlas Staffing</Text>
        </View>

        {!isConfigured ? (
          <Notice tone="bad">This build isn’t connected to a server yet. Add the Supabase URL and anon key to .env and restart.</Notice>
        ) : null}

        <View style={{ gap: 16 }}>
          <Field
            label="Work email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="username"
            autoComplete="email"
            placeholder="you@example.com"
            returnKeyType="next"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
            autoComplete="password"
            placeholder="Password"
            returnKeyType="go"
            onSubmitEditing={signIn}
          />
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Button title="Sign in" onPress={signIn} busy={busy} big />
        </View>

        <Text style={{ color: c.muted, fontSize: 13, lineHeight: 19 }}>
          Your supervisor sets up your login. If you forgot your password, ask them to reset it.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
