/**
 * VocabX configuration.
 *
 * Everything a fork is likely to change lives here: branding, scheduling
 * constants, the AI endpoints and the model. No other module hardcodes them.
 */
export const APP = {
  name: 'VocabX',
  storageKey: 'vocabx.state.v1',
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
  /**
   * The most cards one session will serve, however many have come due.
   *
   * Without a ceiling, a fortnight away turns into a queue of four hundred, and
   * the honest thing an app can do at that point — hand it all over — is the
   * thing that makes people stop. The oldest are served first, so nothing is
   * skipped, only postponed, and the backlog drains over a few days.
   */
  maxSession: 60,
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
/**
 * The engines the app can use.
 *
 * `built-in` needs nothing. The other two both go through your proxy, because
 * an API key in the browser is a key every visitor can read and spend — that
 * rule does not change with the vendor.
 */
export const PROVIDERS = {
  'built-in': {
    label: 'Built-in', blurb: 'Answers from the dictionary on this device. No key, no network, no cost.',
    needsProxy: false,
  },
  anthropic: {
    label: 'Claude', blurb: 'Your proxy calls the Anthropic API. Needs ANTHROPIC_API_KEY on the server.',
    needsProxy: true,
  },
  gemini: {
    label: 'Gemini', blurb: 'Your proxy calls the Google Gemini API. Needs GEMINI_API_KEY on the server.',
    needsProxy: true,
  },
};

export const AI = {
  defaultMode: 'mock',
  defaultEndpoint: 'http://localhost:8787',
  /**
   * The cheapest model that does this job well. Every call is short and
   * tightly specified — a definition, one quiz item, a paragraph of feedback —
   * so Haiku 4.5 at $1/$5 per million tokens is the right tier, not a
   * compromise. Settings offers the others.
   */
  defaultModel: 'claude-haiku-4-5',
  /** Gemini's cheapest tiers. Ids move; GEMINI_MODEL on the server overrides. */
  geminiModels: [
    { id: 'gemini-2.0-flash-lite', label: 'Flash Lite — fastest and cheapest' },
    { id: 'gemini-2.0-flash', label: 'Flash — a step up' },
    { id: 'gemini-2.5-flash', label: 'Flash 2.5 — the most capable of these' },
  ],
  models: [
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest and cheapest' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5 — a step up' },
    { id: 'claude-opus-5', label: 'Opus 5 — the most capable' },
  ],
  routes: {
    word: '/api/ai/word',
    quiz: '/api/ai/quiz',
    coach: '/api/ai/coach',
    suggest: '/api/ai/suggest',
    report: '/api/ai/report',
    assess: '/api/ai/assess',
    ask: '/api/ai/ask',
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
  tag: 'vocabx-reminder',
};
