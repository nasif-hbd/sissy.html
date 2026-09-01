/**
 * Persistence + app state.
 *
 * One plain object holds everything; it is written to localStorage on a short
 * debounce and read back at boot. Swapping in IndexedDB or a backend means
 * reimplementing `read`/`write` below — the rest of the app only ever touches
 * `Store.state`, `Store.commit()` and `Store.on()`.
 */
import { APP, DEFAULTS, AI } from './config.js';
import { DEFAULT_ROUTINE, fromTimes } from './routine.js';

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
      language: 'off',
      dailyGoal: DEFAULTS.dailyGoal,
      newPerDay: DEFAULTS.newPerDay,
      speech: true,
      /* Closed to start with: eight labelled buttons down the side of a phone
         is most of the screen spent on furniture. */
      railOpen: false,
      reminders: { enabled: false, routine: DEFAULT_ROUTINE.map((s, i) => ({ ...s, id: `default-${i}` })), lastFired: {} },
      push: { enabled: false, endpoint: null },
      ai: {
        provider: 'built-in',
        mode: AI.defaultMode, endpoint: AI.defaultEndpoint,
        model: AI.defaultModel, geminiModel: AI.geminiModels[0].id,
      },
    },
    words: {},   // id -> word record
    srs: {},     // id -> scheduling record
    days: {},    // 'YYYY-MM-DD' -> { reviews, correct, learned, seconds }
    history: [], // recent reviews, newest last, capped at 2000
    streak: { current: 0, longest: 0, lastActive: null },
    placement: null,  // the last level check, or null if never sat
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
    /* Translations that shipped with the word (Bangla, Hindi, Chinese come
       with the dataset); anything else is fetched and cached by translate.js. */
    tr: raw.tr && typeof raw.tr === 'object' ? raw.tr : undefined,
    module: raw.module || undefined,
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

/**
 * Saves written before the app was renamed.
 *
 * The key is part of the app's name, so renaming it would have looked, to
 * anyone already using the app, exactly like losing their deck. The old key is
 * read once and copied across; it is left in place rather than deleted, so a
 * browser that still has the old build open keeps working.
 */
const FORMER_KEYS = ['lexio.state.v1'];

function read() {
  try {
    let raw = localStorage.getItem(APP.storageKey);
    if (!raw) {
      const inherited = FORMER_KEYS.map((k) => localStorage.getItem(k)).find(Boolean);
      if (!inherited) return null;
      localStorage.setItem(APP.storageKey, inherited);
      raw = inherited;
    }
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  } catch (err) {
    console.warn('[store] unreadable save, starting fresh', err);
    return null;
  }
}

/* ===========================================================================
   Undo

   Grading a card writes to six places: the schedule, the day counters, the
   streak, XP, the review log and the session queue. Reversing each of those in
   turn is six chances to get it subtly wrong — the streak in particular cannot
   be recomputed from what is left. So undo copies the four parts of state the
   write touches and puts them back, which is exact by construction.

   Pure, so it can be tested without a deck or a browser.
=========================================================================== */
const UNDONE = ['srs', 'days', 'streak', 'xp'];

/** Everything grading `wordId` today is about to change. */
export function snapshot(state, wordId, key = dayKey()) {
  return {
    wordId,
    dayKey: key,
    srs: state.srs[wordId] ? structuredClone(state.srs[wordId]) : null,
    day: state.days[key] ? structuredClone(state.days[key]) : null,
    streak: structuredClone(state.streak),
    xp: structuredClone(state.xp || {}),
    historyLength: state.history.length,
  };
}

/** Put it all back. Mutates `state`, so call it inside a commit. */
export function restore(state, shot) {
  if (!shot) return state;
  if (shot.srs) state.srs[shot.wordId] = shot.srs;
  else delete state.srs[shot.wordId];
  if (shot.day) state.days[shot.dayKey] = shot.day;
  else delete state.days[shot.dayKey];
  state.streak = shot.streak;
  state.xp = shot.xp;
  // Anything logged after the snapshot belongs to the grade being undone.
  state.history.length = shot.historyLength;
  return state;
}

/** Forward-migrations live here; each one bumps `version`. */
function migrate(s) {
  if (!s || typeof s !== 'object') return null;
  // v0 (pre-release) had no `days` map.
  if (!s.days) s.days = {};
  if (!s.history) s.history = [];
  if (!s.settings?.ai) s.settings = { ...freshState().settings, ...(s.settings || {}) };
  // The level check arrived after the first release; older saves have no field.
  if (s.placement === undefined) s.placement = null;
  // The default model moved to the cheapest tier. Anyone still carrying the old
  // default never chose it, so move them; a deliberate pick is left alone.
  if (s.settings?.ai?.model === 'claude-opus-5') s.settings.ai.model = AI.defaultModel;
  // The single Claude/built-in switch became a choice of three engines.
  const ai = s.settings?.ai;
  if (ai && !ai.provider) ai.provider = ai.mode === 'proxy' ? 'anthropic' : 'built-in';
  if (ai && !ai.geminiModel) ai.geminiModel = AI.geminiModels[0].id;
  // Reminders grew from a flat list of times into a routine of steps. Convert
  // rather than discard — someone chose those times.
  const rem = s.settings?.reminders;
  if (rem && !rem.routine) {
    rem.routine = rem.times?.length
      ? fromTimes(rem.times)
      : DEFAULT_ROUTINE.map((step, i) => ({ ...step, id: `default-${i}` }));
    delete rem.times;
    rem.lastFired = {};   // the old keys were times, the new ones are step ids
  }
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

  /**
   * Load from disk, or seed a new install — call once at boot.
   *
   * The starter deck is 6 KB of the download and is read exactly once, on a
   * first run. Fetching it only then keeps it off every load after that.
   */
  async init() {
    const loaded = read();
    if (loaded) {
      this.state = loaded;
      return this.state;
    }
    const { SEED_WORDS } = await import('./data/seed.js');
    this.seed(SEED_WORDS);
    return this.state;
  },

  seed(words) {
    const s = freshState();
    for (const raw of words) {
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
    if (!parsed?.words) throw new Error('Not a VocabX backup — no words found.');
    this.state = parsed;
    this.save(true);
    this.emit();
  },

  async reset() {
    const { SEED_WORDS } = await import('./data/seed.js');
    this.seed(SEED_WORDS);
    this.emit();
  },
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
