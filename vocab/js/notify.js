/**
 * Reminders.
 *
 * Two independent layers, either of which can be used alone:
 *
 *  1. Local reminders — while a tab is open (or restored from bfcache) a one
 *     minute tick checks the user's reminder times and asks the service worker
 *     to raise a notification. Zero backend. This is what the template uses by
 *     default, and what most learners actually need.
 *
 *  2. Web Push — the proxy stores a PushSubscription and can wake the device
 *     even with every tab closed. Optional: needs VAPID keys on the server.
 */
import { NOTIFY, PUSH } from './config.js';
import { Store, dayKey } from './store.js';
import { queueCounts } from './srs.js';

let swReg = null;
let ticker = null;

export const Notifier = {
  get supported() { return 'Notification' in window && 'serviceWorker' in navigator; },
  get permission() { return this.supported ? Notification.permission : 'unsupported'; },

  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      swReg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      return swReg;
    } catch (err) {
      console.warn('[notify] service worker registration failed', err);
      return null;
    }
  },

  /** Ask for permission. Must be called from a user gesture on iOS/Safari. */
  async request() {
    if (!this.supported) return 'unsupported';
    const result = await Notification.requestPermission();
    Store.set('settings.reminders.enabled', result === 'granted');
    if (result === 'granted') this.start();
    return result;
  },

  /**
   * Raise a notification now. Goes through the service worker when one is
   * available so the notification survives the tab being closed and supports
   * action buttons; falls back to a page-level Notification otherwise.
   */
  async show(title, body, { tag = NOTIFY.tag, data = {}, actions = true } = {}) {
    if (this.permission !== 'granted') return false;
    const options = {
      body,
      tag,
      renotify: true,
      badge: iconDataUri(),
      icon: iconDataUri(),
      data: { url: location.href.split('#')[0], ...data },
      actions: actions ? [
        { action: 'review', title: 'Review now' },
        { action: 'snooze', title: 'In 1 hour' },
      ] : [],
    };
    const reg = swReg || (await navigator.serviceWorker?.getRegistration());
    if (reg) { await reg.showNotification(title, options); return true; }
    new Notification(title, options);
    return true;
  },

  /** Start (or restart) the local reminder loop. Safe to call repeatedly. */
  start() {
    this.stop();
    if (this.permission !== 'granted') return;
    ticker = setInterval(() => this.tick(), NOTIFY.tickMs);
    this.tick();
  },

  stop() { clearInterval(ticker); ticker = null; },

  /**
   * One check: has a reminder slot passed today that we have not fired yet,
   * and is there anything worth interrupting the user for?
   */
  tick(now = new Date()) {
    const { reminders, dailyGoal } = Store.state.settings;
    if (!reminders?.enabled || this.permission !== 'granted') return;

    const today = dayKey(now);
    const nowMins = now.getHours() * 60 + now.getMinutes();

    for (const time of reminders.times || []) {
      const [h, m] = time.split(':').map(Number);
      const slotMins = h * 60 + m;
      if (nowMins < slotMins) continue;                       // not yet
      if (nowMins - slotMins > NOTIFY.dedupeMs / 60_000) continue; // long past, skip
      if (reminders.lastFired?.[time] === today) continue;     // already sent

      const counts = queueCounts(Store.state);
      const doneToday = Store.today().reviews;
      const pending = counts.due + counts.learning;
      if (pending === 0 && doneToday >= dailyGoal) continue;   // nothing to nag about

      Store.commit((s) => { (s.settings.reminders.lastFired ??= {})[time] = today; });
      this.show(...reminderCopy({ pending, fresh: counts.new, doneToday, dailyGoal }));
      return;
    }
  },
};

/** Message shown at reminder time — kept in one place so it is easy to reword. */
function reminderCopy({ pending, fresh, doneToday, dailyGoal }) {
  if (pending > 0) {
    return [
      `${pending} word${pending === 1 ? '' : 's'} ready for review`,
      doneToday > 0
        ? `You have done ${doneToday} today. A few more and the day is banked.`
        : 'Two minutes now keeps the streak alive.',
    ];
  }
  if (fresh > 0) {
    return ['Time to meet some new words', `${fresh} new word${fresh === 1 ? '' : 's'} are waiting in your deck.`];
  }
  return ['Keep the streak going', `${doneToday}/${dailyGoal} reviews today.`];
}

// ── Web Push (optional) ─────────────────────────────────────────────────────

export const Push = {
  get supported() { return 'PushManager' in window && 'serviceWorker' in navigator; },

  async enable() {
    if (!this.supported) throw new Error('This browser has no Push support.');
    if (Notifier.permission !== 'granted') {
      const result = await Notifier.request();
      if (result !== 'granted') throw new Error('Notification permission denied.');
    }
    const base = (Store.get('settings.ai.endpoint') || '').replace(/\/+$/, '');
    const keyRes = await fetch(`${base}${PUSH.routes.publicKey}`);
    if (!keyRes.ok) throw new Error('Proxy has no VAPID key configured.');
    const { publicKey } = await keyRes.json();
    if (!publicKey) throw new Error('Proxy has no VAPID key configured.');

    const reg = swReg || (await navigator.serviceWorker.ready);
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const res = await fetch(`${base}${PUSH.routes.subscribe}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subscription: sub,
        times: Store.get('settings.reminders.times'),
        timezoneOffset: new Date().getTimezoneOffset(),
      }),
    });
    if (!res.ok) throw new Error('Proxy rejected the subscription.');
    Store.commit((s) => { s.settings.push = { enabled: true, endpoint: sub.endpoint }; });
    return sub;
  },

  async disable() {
    const reg = swReg || (await navigator.serviceWorker.getRegistration());
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      const base = (Store.get('settings.ai.endpoint') || '').replace(/\/+$/, '');
      await fetch(`${base}${PUSH.routes.unsubscribe}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    Store.commit((s) => { s.settings.push = { enabled: false, endpoint: null }; });
  },
};

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function iconDataUri() {
  return 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#4f46e5"/><text x="50" y="70" font-size="56" text-anchor="middle" fill="white" font-family="sans-serif">Lx</text></svg>`
  );
}
