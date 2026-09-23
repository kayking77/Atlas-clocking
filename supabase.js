import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey && !url.includes('YOUR-PROJECT'));

export const supabase = createClient(url || 'https://not-configured.supabase.co', anonKey || 'missing', {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Only refresh the session while the app is in the foreground.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});

/**
 * Database errors from the clock RPCs look like "OUTSIDE_GEOFENCE: you are 212 m from Maple House…".
 * Split them into a code the app can branch on and a sentence staff can read.
 */
export function readError(error) {
  const raw = (error && (error.message || error.error_description || String(error))) || 'Something went wrong.';
  const m = raw.match(/^([A-Z_]{3,}):\s*(.*)$/s);
  if (m) return { code: m[1], message: m[2] || m[1] };
  if (/network|fetch/i.test(raw)) {
    return { code: 'NETWORK', message: 'No connection. Check your signal or Wi-Fi and try again.' };
  }
  if (/invalid login credentials/i.test(raw)) {
    return { code: 'BAD_LOGIN', message: 'That email and password don’t match. Try again or ask your supervisor to reset it.' };
  }
  return { code: 'UNKNOWN', message: raw };
}
