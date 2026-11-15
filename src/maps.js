// Live drive time (Google Routes API, with traffic). Needs GOOGLE_MAPS_KEY.
const KEY = () => process.env.GOOGLE_MAPS_KEY || '';
export const enabled = () => !!KEY();
const cache = new Map();
export async function driveMinutes(lat, lng, address) {
  if (!enabled() || !address) return null;
  const k = `${lat.toFixed(3)},${lng.toFixed(3)}|${address}`, c = cache.get(k);
  if (c && Date.now() - c.at < 8 * 60e3) return c.min;
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST', signal: AbortSignal.timeout(15e3),
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': KEY(), 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters' },
    body: JSON.stringify({ origin: { location: { latLng: { latitude: lat, longitude: lng } } }, destination: { address: String(address).slice(0, 300) }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', regionCode: 'AE' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('routes', r.status, JSON.stringify(j).slice(0, 300)); return null; }
  const sec = parseInt(String(j.routes?.[0]?.duration || '').replace('s', ''), 10);
  if (!sec) return null;
  const min = Math.ceil(sec / 60); cache.set(k, { min, km: Math.round((j.routes[0].distanceMeters || 0) / 100) / 10, at: Date.now() });
  return min;
}
