// Dioma notifications: pop-up with sound/vibration, even when the app is closed or the phone is locked.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Dioma', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, requireInteraction: !!d.urgent,
    vibrate: d.urgent ? [300, 150, 300, 150, 600] : [200, 100, 200], icon: '/icon-512.png', badge: '/icon-180.png', data: { url: d.url || '/#home' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/#home';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => { for (const c of cs) { if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); } } return self.clients.openWindow(url); }));
});
