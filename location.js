import * as Location from 'expo-location';

/**
 * Get one fresh, high-accuracy GPS fix. Location is only read at clock-in and
 * clock-out — the app never tracks staff in the background.
 * Resolves { lat, lng, accuracy, mocked, at } or throws { code, message }.
 */
export async function getFix({ timeoutMs = 15000 } = {}) {
  const services = await Location.hasServicesEnabledAsync();
  if (!services) {
    throw { code: 'LOCATION_OFF', message: 'Location services are off. Turn them on in your phone’s settings to clock in.' };
  }
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') {
    throw {
      code: 'LOCATION_DENIED',
      message: 'Atlas Timeclock needs location permission to clock you in. Allow “While Using the App” in Settings.',
      canAskAgain: perm.canAskAgain,
    };
  }

  const fix = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: true }),
    new Promise((_, reject) =>
      setTimeout(() => reject({ code: 'LOCATION_TIMEOUT', message: 'Couldn’t get a GPS fix. Move near a window or step outside, then try again.' }), timeoutMs)
    ),
  ]);

  return {
    lat: fix.coords.latitude,
    lng: fix.coords.longitude,
    accuracy: fix.coords.accuracy == null ? null : Math.round(fix.coords.accuracy),
    mocked: Boolean(fix.mocked), // Android reports fake-GPS apps here
    at: fix.timestamp || Date.now(),
  };
}

export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatCoords(lat, lng) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lng).toFixed(5)}° ${ew}`;
}
