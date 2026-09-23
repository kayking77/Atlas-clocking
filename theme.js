import { useColorScheme, Platform } from 'react-native';

// Atlas palette — survey-map blue on a cool paper ground.
const light = {
  ground: '#F2F4F3',
  surface: '#FFFFFF',
  sunk: '#E7ECEA',
  ink: '#14202B',
  muted: '#5B6873',
  line: '#D6DEDA',
  accent: '#2446C7',
  accentInk: '#FFFFFF',
  accentSoft: '#E3E9FB',
  on: '#157347',
  onSoft: '#DCF0E4',
  warn: '#9A5B06',
  warnSoft: '#FBEED6',
  bad: '#B8392A',
  badSoft: '#F8E0DC',
};

const dark = {
  ground: '#0D141A',
  surface: '#151E26',
  sunk: '#1C2731',
  ink: '#E4EAEE',
  muted: '#90A0AB',
  line: '#26343F',
  accent: '#8EA6FF',
  accentInk: '#0D141A',
  accentSoft: '#1F2A4D',
  on: '#4CC486',
  onSoft: '#16332A',
  warn: '#E3A948',
  warnSoft: '#3A2C12',
  bad: '#F07B6B',
  badSoft: '#3D1C18',
};

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export function useTheme() {
  const scheme = useColorScheme();
  return scheme === 'dark' ? { c: dark, dark: true } : { c: light, dark: false };
}
