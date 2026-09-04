/**
 * Keeping a learner's work somewhere other than this one browser.
 *
 * Entirely optional. VocabX has always worked with nothing but localStorage,
 * and it still does: every function here fails quietly and the app carries on.
 * What this adds is that clearing your browser, or picking up a second device,
 * no longer means starting from zero.
 *
 * ── The id ──────────────────────────────────────────────────────────────────
 *
 * A random id the device makes for itself on first use. Not the IP address,
 * which is the obvious choice and the wrong one: carriers put thousands of
 * phones behind a single public address, so an IP key would hand strangers
 * each other's progress and each other's questions — and it changes under the
 * same person when they move cell or rejoin wifi, so it would lose theirs too.
 *
 * It is not a login and does not pretend to be. Whoever holds the id can read
 * the data, which is exactly the promise localStorage already makes; the id
 * simply outlives the browser that made it. Someone who wants their work on a
 * second device copies the id across, and someone who wants it gone presses
 * forget.
 */
import { Store } from './store.js';
import { AI } from './config.js';

const KEY = 'vocabx.device';

/** 22 characters of real randomness — a UUID with the hyphens taken out. */
function mint() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
}

/**
 * This device's id, made once and then remembered.
 *
 * Read through a function rather than a constant so a browser that refuses
 * localStorage — private mode, storage disabled — gets a working app with
 * sync switched off, rather than a crash on the first import.
 */
export function deviceId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = mint();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/** Replace this device's id with one from another device, to join up. */
export function adoptId(id) {
  const clean = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(clean)) return false;
  try { localStorage.setItem(KEY, clean); return true; } catch { return false; }
}

/** Whether syncing is even possible: an id, a proxy, and the user's consent. */
export function enabled() {
  return Boolean(deviceId() && AI.proxyUrl && Store.state.settings.sync?.enabled);
}

async function call(route, payload) {
  const uid = deviceId();
  if (!uid) return null;
  try {
    const res = await fetch(`${AI.proxyUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid, ...payload }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(12_000) : undefined,
    });
    const out = await res.json();
    return out?.ok ? out : null;
  } catch {
    // Offline, no database bound, proxy asleep — all the same to the caller,
    // which is the point: nothing here is allowed to interrupt studying.
    return null;
  }
}

/**
 * What is worth sending.
 *
 * Derived from the state rather than being the state: the schedule, the words
 * met and the day ledger are what someone would grieve losing. Settings stay
 * on the device they were chosen on — a phone and a laptop want different
 * reminder times, and syncing them would be a bug wearing a feature's clothes.
 */
export function snapshotOf(state) {
  return {
    v: 1,
    words: state.words,
    srs: state.srs,
    days: state.days,
    streak: state.streak,
    xp: state.xp,
    // The last 400 gradings, which is enough to rebuild "weakest words"
    // without sending a log of everything ever answered.
    history: (state.history || []).slice(-400),
  };
}

export const Sync = {
  deviceId,
  adoptId,
  enabled,

  /** Push the current work up. Returns the server's timestamp, or null. */
  async push(state) {
    if (!enabled()) return null;
    const out = await call('/api/sync/progress', { snapshot: snapshotOf(state) });
    return out?.at || null;
  },

  /** Pull whatever is stored, without applying it — the caller decides. */
  async pull() {
    if (!enabled()) return null;
    const out = await call('/api/sync/progress/get', {});
    return out?.found ? { at: out.at, snapshot: out.snapshot } : null;
  },

  /** Keep one question and its answer. Fire and forget. */
  async saveChat(question, answer, engine) {
    if (!enabled()) return false;
    return Boolean(await call('/api/sync/chat', { question, answer, engine }));
  },

  /** The questions asked before, newest first. */
  async chats(limit = 50) {
    if (!enabled()) return [];
    const out = await call('/api/sync/chat/list', { limit });
    return out?.chats || [];
  },

  /** Delete everything held for this id. */
  async forget() {
    if (!deviceId()) return false;
    return Boolean(await call('/api/sync/forget', {}));
  },
};

/**
 * Push, but not more than once a minute however often it is called.
 *
 * Grading a card changes the state, and a session is a hundred gradings. This
 * is what stops that being a hundred writes.
 */
let pending = null;
export function pushSoon(state, wait = 60_000) {
  if (!enabled()) return;
  clearTimeout(pending);
  pending = setTimeout(() => Sync.push(state), wait);
}
