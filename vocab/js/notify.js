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
import { dueStep, cardFor, quoteFor } from './routine.js';

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
   * One check: is a step of the routine due, and is there anything to say?
   *
   * Each step decides its own card, so the 08:00 word and the 21:00 module
   * nudge no longer share one generic message.
   */
  tick(now = new Date()) {
    const { reminders } = Store.state.settings;
    if (!reminders?.enabled || this.permission !== 'granted') return;

    const today = dayKey(now);
    const step = dueStep(reminders.routine, {
      now, today, fired: reminders.lastFired || {},
    });
    if (!step) return;

    const card = cardFor(step, cardContext(step));
    // A step with nothing worth saying still counts as handled, or it will be
    // reconsidered every minute for the rest of its window.
    Store.commit((s) => { (s.settings.reminders.lastFired ??= {})[step.id] = today; });
    if (!card) return;

    this.show(card.title, card.body, {
      data: { view: card.view },
      // The lock-screen cards are things to read, not tasks — action buttons
      // on them would be noise.
      actions: !card.quiet,
    });
  },
};

/** What the routine needs to know about the learner, gathered at fire time. */
function cardContext(step) {
  const state = Store.state;
  const counts = queueCounts(state);
  const base = {
    due: counts.due,
    learning: counts.learning,
    fresh: counts.new,
    doneToday: Store.today().reviews,
    dailyGoal: state.settings.dailyGoal,
  };

  if (step.action === 'quote') {
    return { ...base, quote: state.settings.reminders.quote || quoteFor(dayKey()) };
  }
  if (step.action === 'word') return { ...base, word: pickCardWord(state) };
  if (step.action === 'module') return { ...base, ...nextModule(state) };
  return base;
}

/**
 * The word to put on the lock screen.
 *
 * Something they are mid-way through beats something brand new: the card is a
 * free repetition, and a word already in the deck is the one repetition helps.
 */
function pickCardWord(state) {
  const words = Object.values(state.words || {});
  if (!words.length) return null;
  const inFlight = words.filter((w) => {
    const rec = state.srs?.[w.id];
    return rec && rec.state !== 'new' && w.definition;
  });
  const pool = inFlight.length ? inFlight : words.filter((w) => w.definition);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** The module and set the learner is part-way through, for a module step. */
function nextModule(state) {
  const lessons = state.lessons || {};
  let best = null;
  for (const [id, sets] of Object.entries(lessons)) {
    const results = Object.values(sets);
    const at = Math.max(0, ...results.map((r) => r?.at || 0));
    if (!best || at > best.at) {
      const passed = Object.keys(sets).filter((i) => sets[i]?.passed).map(Number);
      best = { at, id, next: (passed.length ? Math.max(...passed) + 1 : 0) + 1 };
    }
  }
  if (!best) return {};
  const title = state.moduleTitles?.[best.id] || best.id.toUpperCase();
  return { moduleTitle: title, setNumber: best.next };
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
        // The server fires these when the app is closed, so it needs the whole
        // routine — the times alone cannot say what each one is for.
        routine: Store.get('settings.reminders.routine') || [],
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
