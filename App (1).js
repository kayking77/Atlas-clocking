import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { supabase, readError } from './src/lib/supabase';
import { useTheme } from './src/theme';
import { Button, Notice } from './src/ui';
import LoginScreen from './src/screens/LoginScreen';
import ClockScreen from './src/screens/ClockScreen';
import PeriodScreen from './src/screens/PeriodScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const { c, dark } = useTheme();
  const [session, setSession] = useState(undefined); // undefined = still loading
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState(null);
  const [tab, setTab] = useState('clock');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s || null));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setProfileError(null);
    if (!session) return;
    supabase
      .from('profiles')
      .select('id, full_name, role, active')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setProfileError(readError(error).message);
        else if (!data) setProfileError('Your login isn’t linked to an Atlas staff profile. Contact your supervisor.');
        else if (!data.active) setProfileError('Your account is inactive. Contact your supervisor.');
        else setProfile(data);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const signOut = () => supabase.auth.signOut();

  let body;
  if (session === undefined) {
    body = <ActivityIndicator style={{ flex: 1 }} color={c.accent} />;
  } else if (!session) {
    body = <LoginScreen />;
  } else if (profileError) {
    body = (
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 16 }}>
        <Notice tone="bad">{profileError}</Notice>
        <Button title="Sign out" kind="quiet" onPress={signOut} />
      </View>
    );
  } else if (!profile) {
    body = <ActivityIndicator style={{ flex: 1 }} color={c.accent} />;
  } else {
    body = (
      <View style={{ flex: 1 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line }}>
          <View>
            <Text style={{ color: c.ink, fontSize: 15, fontWeight: '800', letterSpacing: 3 }}>ATLAS</Text>
            <Text style={{ color: c.muted, fontSize: 13 }}>{profile.full_name}</Text>
          </View>
          <Pressable onPress={signOut} hitSlop={10} accessibilityRole="button">
            <Text style={{ color: c.accent, fontSize: 15, fontWeight: '600' }}>Sign out</Text>
          </Pressable>
        </View>

        <View style={{ flex: 1 }}>
          {tab === 'clock' ? (
            <ClockScreen profile={profile} onChanged={() => setRefreshKey((k) => k + 1)} />
          ) : (
            <PeriodScreen profile={profile} refreshKey={refreshKey} />
          )}
        </View>

        {/* Tab bar */}
        <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.surface }}>
          {[
            ['clock', 'Clock'],
            ['period', 'Timesheet'],
          ].map(([key, label]) => (
            <Pressable
              key={key}
              onPress={() => setTab(key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === key }}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 14, borderTopWidth: 3, borderTopColor: tab === key ? c.accent : 'transparent' }}
            >
              <Text style={{ color: tab === key ? c.accent : c.muted, fontSize: 15, fontWeight: '700' }}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.ground }} edges={['top', 'bottom']}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      {body}
    </SafeAreaView>
  );
}
