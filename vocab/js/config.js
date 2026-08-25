/**
 * Lexio configuration.
 *
 * Everything a fork is likely to change lives here: branding, scheduling
 * constants, the AI endpoints and the model. No other module hardcodes them.
 */
export const APP = {
  name: 'Lexio',
  tagline: 'English vocabulary',
  storageKey: 'lexio.state.v1',
  schemaVersion: 1,
};

/** Spaced-repetition tuning (see js/srs.js for how each value is used). */
export const SRS = {
  /** Minutes between the steps a card walks through before graduating. */
  learningSteps: [1, 10],
  /** Interval in days awarded on graduation, and on an "easy" graduation. */
  graduatingInterval: 1,
  easyInterval: 4,
  /** Ease factor bounds and deltas, SM-2 style. */
  startingEase: 2.5,
  minEase: 1.3,
  easeDelta: { again: -0.20, hard: -0.15, good: 0, easy: 0.15 },
  hardFactor: 1.2,
  easyBonus: 1.3,
  /** Multiplier applied to the interval after a lapse. */
  lapseFactor: 0.5,
  /** Reviews are randomised by ±5% so cards don't clump on one day. */
  fuzz: 0.05,
  /** A card with this many lapses is flagged as a leech ("struggling"). */
  leechThreshold: 5,
  /** Interval in days at which a card counts as "mastered" for stats. */
  masteredInterval: 21,
  maxInterval: 365,
};

/** Defaults applied to a fresh install; the user can change all of them. */
export const DEFAULTS = {
  dailyGoal: 20,
  newPerDay: 10,
  level: 'B1',
  theme: 'auto',
  reminderTimes: ['09:00', '20:00'],
};

/**
 * The themes offered in Settings. `id` is what lands in `data-theme` on <html>
 * and selects a palette in styles.css; `paper`/`accent` only draw the swatch.
 * Add one here and in the stylesheet — nothing else needs to know.
 */
export const THEMES = [
  { id: 'auto',  label: 'Auto',  paper: '#f6f7f8', accent: '#e2620a', note: 'follows the device' },
  { id: 'paper', label: 'Paper', paper: '#ffffff', accent: '#e2620a', note: 'white, orange' },
  { id: 'linen', label: 'Linen', paper: '#f2efe8', accent: '#0f6f70', note: 'off-white, teal' },
  { id: 'ink',   label: 'Ink',   paper: '#12151a', accent: '#4d9dff', note: 'black, blue' },
];

/**
 * AI wiring.
 *
 * `mock`  — no network. The built-in tutor answers from the dictionary and
 *           module packs that ship with the app (js/local.js), so every AI
 *           feature works on a fresh install with no key and no server.
 * `proxy` — the browser calls YOUR server, which holds the Anthropic API key
 *           and calls the Claude API. Never ship a key to the browser.
 */
export const AI = {
  defaultMode: 'mock',
  defaultEndpoint: 'http://localhost:8787',
  defaultModel: 'claude-opus-5',
  routes: {
    word: '/api/ai/word',
    quiz: '/api/ai/quiz',
    coach: '/api/ai/coach',
    suggest: '/api/ai/suggest',
    report: '/api/ai/report',
    health: '/api/health',
  },
  timeoutMs: 45_000,
};

/** Push endpoints on the same proxy. */
export const PUSH = {
  routes: {
    publicKey: '/api/push/public-key',
    subscribe: '/api/push/subscribe',
    unsubscribe: '/api/push/unsubscribe',
    test: '/api/push/test',
  },
};

export const NOTIFY = {
  /** How often the open tab re-checks whether a reminder is due (ms). */
  tickMs: 60_000,
  /** Don't fire the same reminder slot twice within this window (ms). */
  dedupeMs: 30 * 60_000,
  tag: 'lexio-reminder',
};
