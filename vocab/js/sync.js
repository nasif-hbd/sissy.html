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
import { Auth } from './auth.js';

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

/**
 * Whether syncing is even possible.
 *
 * Signing in is the consent — keeping your work is the whole reason anyone
 * makes an account, and asking a second time in Settings would be a toggle
 * that only ever confuses. A guest still has to ask for it.
 */
export function enabled() {
  if (!AI.proxyUrl) return false;
  if (Auth.isIn) return true;
  return Boolean(deviceId() && Store.state.settings.sync?.enabled);
}

/**
 * How this request says who it is.
 *
 * A session token when there is one, and then no device id at all: sending
 * both would ask the server to choose, and the server's answer to that is to
 * refuse. A guest sends the id their device made for itself.
 */
function whoAmI() {
  if (Auth.isIn) return { token: Auth.token };
  const uid = deviceId();
  return uid ? { uid } : null;
}

async function call(route, payload) {
  const who = whoAmI();
  if (!who) return null;
  try {
    const res = await fetch(`${AI.proxyUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...who, ...payload }),
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

/**
 * Two histories of the same learner, joined so neither is lost.
 *
 * This is the case that quietly destroys work if you get it wrong: someone
 * studies as a guest for a fortnight, then signs in to an account that
 * already has a snapshot from their old phone. Pick either side and the other
 * fortnight is gone, with no warning and no undo. So neither is picked.
 *
 * Every field has an answer that cannot lose:
 *
 *   words    union — a word met on either device was met
 *   srs      whichever card was reviewed more recently. That is the truer
 *            schedule; taking the one further ahead instead would promote a
 *            card the learner has since forgotten and stop showing it
 *   days     per day, the larger of each counter — never the sum. The same
 *            day studied on two devices really did contain both sets of
 *            reviews, but a device's own numbers come back to it on the next
 *            sync, and adding would inflate that day a little more every
 *            time. Larger loses at most the smaller side once; adding is
 *            wrong forever
 *   history  both, in time order, capped
 *   streak   the longer run, and the later day active
 *   xp       the larger total, for the same reason as days
 */
export function mergeSnapshots(mine, theirs) {
  if (!theirs || typeof theirs !== 'object') return mine;
  if (!mine || typeof mine !== 'object') return theirs;

  const words = { ...theirs.words, ...mine.words };

  const srs = { ...theirs.srs };
  for (const [id, ours] of Object.entries(mine.srs || {})) {
    const other = srs[id];
    srs[id] = !other || newer(ours, other) ? ours : other;
  }

  const days = { ...theirs.days };
  for (const [key, ours] of Object.entries(mine.days || {})) {
    const other = days[key];
    if (!other) { days[key] = ours; continue; }
    const out = { ...other };
    for (const field of Object.keys(ours)) out[field] = Math.max(ours[field] || 0, other[field] || 0);
    days[key] = out;
  }

  /* Both logs, in order, deduplicated on the timestamp and word together —
     the same review synced twice is one review, and two different words
     graded in the same millisecond are two. */
  const seen = new Set();
  const history = [...(theirs.history || []), ...(mine.history || [])]
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .filter((h) => {
      const key = `${h.ts}:${h.id || h.term || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-400);

  const lastActive = [mine.streak?.lastActive, theirs.streak?.lastActive]
    .filter(Boolean).sort().pop() || null;

  return {
    v: 1,
    words,
    srs,
    days,
    history,
    streak: {
      current: Math.max(mine.streak?.current || 0, theirs.streak?.current || 0),
      longest: Math.max(mine.streak?.longest || 0, theirs.streak?.longest || 0),
      lastActive,
    },
    xp: (mine.xp?.total || 0) >= (theirs.xp?.total || 0) ? mine.xp : theirs.xp,
  };
}

/** Which of two cards was studied last. A card never seen loses to one seen. */
function newer(a, b) {
  const at = a?.lastReviewed || 0;
  const bt = b?.lastReviewed || 0;
  if (at !== bt) return at > bt;
  return (a?.reps || 0) >= (b?.reps || 0);
}

/** Whether this device has anything a merge would be protecting. */
export function hasWork(state) {
  return Boolean(state?.history?.length) || Object.keys(state?.srs || {}).length > 0;
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

  /** Delete everything held for whoever this is. */
  async forget() {
    if (!whoAmI()) return false;
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
