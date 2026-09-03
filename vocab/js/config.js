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
  /**
   * Which build is actually running, printed at the foot of Settings.
   *
   * A PWA keeps serving itself from its own cache, so "I deployed it" and
   * "the browser is running it" are different claims — and telling them apart
   * by hunting for a changed sentence somewhere in the interface is how an
   * afternoon disappears. Bumped with the service worker's cache name.
   */
  build: 'v34',
  /**
   * Where feedback goes when there is no proxy to post it to.
   *
   * The hosted build has no server behind it, so "Send" can only save the note
   * on the device — which means nobody ever reads it. This address is what the
   * "Send by email instead" button opens the mail app to.
   */
  feedbackTo: 'researcher.flame@gmail.com',
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
/**
 * Themes, in the order the toggle cycles them.
 *
 * "Auto" follows the device and paints Iris by day and Ink by night. The three
 * named ones are there because the palette is a matter of taste and a learner
 * who dislikes it is not going to stay: Iris is the current design, Paper is
 * the one this app shipped with, and Linen and Ink are the warm and dark ends.
 */
export const THEMES = [
  { id: 'auto',  label: 'Auto',  paper: '#f7f8fa', accent: '#6c5ce7', note: 'follows the device' },
  { id: 'iris',  label: 'Iris',  paper: '#f7f8fa', accent: '#6c5ce7', note: 'light, violet' },
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
  /* Blurbs are read by whoever opens the app, not by whoever deployed it, so
     they say what changes for the reader rather than naming an environment
     variable on a server they will never see. */
  anthropic: {
    label: 'Claude', blurb: 'Answers are written fresh by Claude. Best for open questions and nuance.',
    needsProxy: true,
  },
  gemini: {
    label: 'Gemini', blurb: 'Answers are written fresh by Google Gemini. Fast, and good at plain explanations.',
    needsProxy: true,
  },
};

export const AI = {
  defaultMode: 'mock',
  /**
   * Where the AI server is. Set once, here, for everyone using this build.
   *
   * Empty means "the same address this app is served from", which is right
   * whenever the proxy serves the app too — and is right without anyone
   * having to know it, which is the point. Put a full https:// address here
   * to point a build at a proxy hosted somewhere else.
   *
   * Asking each person for this was the mistake: it is a property of the
   * deployment, not a preference, and the one person who knows the answer is
   * whoever deployed it.
   */
  proxyUrl: 'https://vocabx-proxy.mdmukul666343.workers.dev',
  defaultEndpoint: 'http://localhost:8787',
  /**
   * The cheapest model that does this job well. Every call is short and
   * tightly specified — a definition, one quiz item, a paragraph of feedback —
   * so Haiku 4.5 at $1/$5 per million tokens is the right tier, not a
   * compromise. Settings offers the others.
   */
  defaultModel: 'claude-haiku-4-5',
  /**
   * Gemini's cheap tiers, every one of them called once before it was listed.
   *
   * Google retires ids, and a retired id answers 404 rather than falling back
   * — the 2.0 Flash ids that used to be here now do exactly that. So the
   * default is a floating alias that Google keeps pointing at something live,
   * with a pinned version beside it for anyone who would rather the model
   * never changed under them. GEMINI_MODEL on the server overrides both.
   */
  geminiModels: [
    { id: 'gemini-flash-lite-latest', label: 'Flash Lite — fastest and cheapest' },
    { id: 'gemini-3.5-flash-lite', label: 'Flash Lite 3.5 — the same, pinned' },
    { id: 'gemini-3.5-flash', label: 'Flash 3.5 — a step up' },
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
