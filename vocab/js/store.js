/**
 * Persistence + app state.
 *
 * One plain object holds everything; it is written to localStorage on a short
 * debounce and read back at boot. Swapping in IndexedDB or a backend means
 * reimplementing `read`/`write` below — the rest of the app only ever touches
 * `Store.state`, `Store.commit()` and `Store.on()`.
 */
import { APP, DEFAULTS, AI } from './config.js';
import { SEED_WORDS } from './data/seed.js';

/** YYYY-MM-DD in the user's own timezone (never UTC — streaks are local). */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysAgoKey(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayKey(d);
}

export function slugify(term) {
  return term.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function freshState() {
  return {
    version: APP.schemaVersion,
    createdAt: Date.now(),
    profile: { level: DEFAULTS.level },
    settings: {
      theme: DEFAULTS.theme,
      dailyGoal: DEFAULTS.dailyGoal,
      newPerDay: DEFAULTS.newPerDay,
      speech: true,
      reminders: { enabled: false, times: [...DEFAULTS.reminderTimes], lastFired: {} },
      push: { enabled: false, endpoint: null },
      ai: { mode: AI.defaultMode, endpoint: AI.defaultEndpoint, model: AI.defaultModel },
    },
    words: {},   // id -> word record
    srs: {},     // id -> scheduling record
    days: {},    // 'YYYY-MM-DD' -> { reviews, correct, learned, seconds }
    history: [], // recent reviews, newest last, capped at 2000
    streak: { current: 0, longest: 0, lastActive: null },
  };
}

/** Turn a seed/AI word payload into a stored word record. */
export function makeWord(raw, source = 'seed') {
  const id = slugify(raw.term);
  return {
    id,
    term: raw.term.trim(),
    phonetic: raw.phonetic || '',
    pos: raw.pos || '',
    definition: raw.definition || '',
    examples: Array.isArray(raw.examples) ? raw.examples.slice(0, 4) : [],
    synonyms: Array.isArray(raw.synonyms) ? raw.synonyms.slice(0, 6) : [],
    antonyms: Array.isArray(raw.antonyms) ? raw.antonyms.slice(0, 6) : [],
    mnemonic: raw.mnemonic || '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    level: raw.level || '',
    source,
    addedAt: Date.now(),
  };
}

/** A never-studied scheduling record. Due immediately so new cards surface. */
export function makeSrs() {
  return {
    state: 'new',        // new | learning | review
    step: 0,             // index into SRS.learningSteps while in `learning`
    ease: 2.5,
    interval: 0,         // days (review cards only)
    due: Date.now(),
    reps: 0,
    lapses: 0,
    lastReviewed: null,
    lastGrade: null,
  };
}

function read() {
  try {
    const raw = localStorage.getItem(APP.storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  } catch (err) {
    console.warn('[store] unreadable save, starting fresh', err);
    return null;
  }
}

/** Forward-migrations live here; each one bumps `version`. */
function migrate(s) {
  if (!s || typeof s !== 'object') return null;
  // v0 (pre-release) had no `days` map.
  if (!s.days) s.days = {};
  if (!s.history) s.history = [];
  if (!s.settings?.ai) s.settings = { ...freshState().settings, ...(s.settings || {}) };
  // themes were system/light/dark before they were named
  const renamed = { system: 'auto', light: 'paper', dark: 'ink' };
  if (renamed[s.settings?.theme]) s.settings.theme = renamed[s.settings.theme];
  s.version = APP.schemaVersion;
  return s;
}

let saveTimer = null;

export const Store = {
  state: freshState(),
  listeners: new Set(),

  /** Load from disk (or seed a new install) — call once at boot. */
  init() {
    const loaded = read();
    if (loaded) {
      this.state = loaded;
    } else {
      this.seed();
    }
    return this.state;
  },

  seed() {
    const s = freshState();
    for (const raw of SEED_WORDS) {
      const w = makeWord(raw, 'seed');
      s.words[w.id] = w;
      s.srs[w.id] = makeSrs();
    }
    this.state = s;
    this.save(true);
  },

  save(immediate = false) {
    clearTimeout(saveTimer);
    const write = () => {
      try {
        localStorage.setItem(APP.storageKey, JSON.stringify(this.state));
      } catch (err) {
        console.error('[store] save failed — storage may be full', err);
      }
    };
    if (immediate) write();
    else saveTimer = setTimeout(write, 250);
  },

  /** Mutate + persist + notify, in one call: Store.commit(s => { ... }). */
  commit(fn) {
    fn(this.state);
    this.save();
    this.emit();
  },

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { for (const fn of this.listeners) fn(this.state); },

  // ── words ────────────────────────────────────────────────────────────────
  addWord(raw, source = 'user') {
    const word = makeWord(raw, source);
    if (!word.id) return null;
    this.commit((s) => {
      const existing = s.words[word.id];
      s.words[word.id] = existing ? { ...existing, ...word, addedAt: existing.addedAt } : word;
      if (!s.srs[word.id]) s.srs[word.id] = makeSrs();
    });
    return this.state.words[word.id];
  },

  updateWord(id, patch) {
    this.commit((s) => { if (s.words[id]) Object.assign(s.words[id], patch); });
    return this.state.words[id];
  },

  deleteWord(id) {
    this.commit((s) => { delete s.words[id]; delete s.srs[id]; });
  },

  hasWord(term) { return Boolean(this.state.words[slugify(term)]); },

  // ── day counters + streak ────────────────────────────────────────────────
  today() {
    const key = dayKey();
    const d = this.state.days[key];
    return d || { reviews: 0, correct: 0, learned: 0, seconds: 0 };
  },

  bumpDay(patch) {
    const key = dayKey();
    this.commit((s) => {
      const d = s.days[key] || { reviews: 0, correct: 0, learned: 0, seconds: 0 };
      for (const [k, v] of Object.entries(patch)) d[k] = (d[k] || 0) + v;
      s.days[key] = d;
      // Only a real review keeps the streak alive — time on screen doesn't.
      if (patch.reviews > 0) touchStreak(s, key);
    });
  },

  /** Append to the rolling review log (used by stats + the AI report). */
  logReview(entry) {
    this.commit((s) => {
      s.history.push({ ts: Date.now(), ...entry });
      if (s.history.length > 2000) s.history.splice(0, s.history.length - 2000);
    });
  },

  // ── settings ─────────────────────────────────────────────────────────────
  set(path, value) {
    this.commit((s) => {
      const keys = path.split('.');
      let node = s;
      for (const k of keys.slice(0, -1)) node = node[k] ??= {};
      node[keys.at(-1)] = value;
    });
  },

  get(path, fallback = undefined) {
    return path.split('.').reduce((node, k) => (node == null ? node : node[k]), this.state) ?? fallback;
  },

  // ── import / export ──────────────────────────────────────────────────────
  export() {
    return JSON.stringify({ ...this.state, exportedAt: new Date().toISOString() }, null, 2);
  },

  import(json) {
    const parsed = migrate(JSON.parse(json));
    if (!parsed?.words) throw new Error('Not a Lexio backup — no words found.');
    this.state = parsed;
    this.save(true);
    this.emit();
  },

  reset() { this.seed(); this.emit(); },
};

/** Streak = consecutive local days with at least one review. */
function touchStreak(s, key) {
  const st = s.streak;
  if (st.lastActive === key) return;
  const yesterday = daysAgoKey(1);
  st.current = st.lastActive === yesterday ? st.current + 1 : 1;
  st.lastActive = key;
  st.longest = Math.max(st.longest || 0, st.current);
}

/** Recompute the streak at boot so a missed day shows as 0, not stale. */
export function refreshStreak(state) {
  const { lastActive } = state.streak;
  if (!lastActive) return;
  if (lastActive !== dayKey() && lastActive !== daysAgoKey(1)) {
    state.streak.current = 0;
  }
}
