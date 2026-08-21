# Lexio — English vocabulary app template

A complete, dependency-free starting point for a vocabulary learning app:
**spaced repetition**, **reminders**, **progress tracking** and **Claude AI**
already wired together and talking to each other.

No build step, no framework, no bundler. Open `index.html` and it runs.

```
vocab/
├── index.html          app shell
├── styles.css          the design system: tokens, then every component
├── fonts/              Fraunces · Newsreader · Space Grotesk (vendored)
├── sw.js               offline cache, push + notification handling
├── manifest.webmanifest installable PWA
├── js/
│   ├── app.js          controller — wires DOM to the modules below
│   ├── config.js       every tunable constant lives here
│   ├── store.js        persistence, schema, import/export
│   ├── srs.js          SM-2 scheduler (pure functions)
│   ├── stats.js        streaks, accuracy, heatmap, forecast
│   ├── notify.js       reminders (local) + Web Push (optional)
│   ├── ai.js           Claude adapter, offline + proxy modes
│   ├── ui.js           rendering
│   └── data/seed.js    40-word starter deck — swap this out
├── server/             the only place an API key exists
│   ├── proxy.mjs       Node server: Claude routes + push + static app
│   ├── prompts.mjs     every prompt and output schema
│   └── smoke.mjs       hits each route and prints the wire shapes
└── tests/             scheduler, tracking and design-system tests
```

## Quick start

**Offline, right now** — the app ships with sample AI responses, so nothing is
required to try it:

```bash
cd vocab
python3 -m http.server 8000      # or: npx http-server -p 8000
open http://localhost:8000
```

**With real AI** — the proxy holds the key and also serves the app, so there is
one origin and no CORS to configure:

```bash
cd vocab/server
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start      # → http://localhost:8787
```

Then open Settings → AI → **Proxy**, endpoint `http://localhost:8787`. The
status line under it tells you whether the proxy answered and whether it has a
key.

## The look

The app is styled as **a pocket lexicon** rather than a language app: printed
stock, black keylines, a correction pen in the margin. Hairline rules and small
caps instead of pill-shaped chrome, sharp corners with a hard offset shadow so
cards read as printed card stock. There is no emoji anywhere — the marks are a
printer's: **☞** for a memory hook, **❦** on an empty queue.

Three decisions carry most of it:

- **Type does the work.** Fraunces sets the headwords (its `SOFT` and `WONK`
  axes give the slight eccentricity), Newsreader sets the readable matter and
  its italic carries the example sentences, Space Grotesk holds the chrome.
  All three are vendored in `fonts/` — no third-party request, no flash of
  fallback text, and the typography survives offline.
- **AI output is marginalia.** Anything Claude writes appears against a tinted
  margin with a dagger, the way an annotation sits beside a printed entry —
  never styled as the app's own voice.
- **Charts are printed, not plotted.** Activity is a dot-density grid, the
  fortnight is ink columns on a ruled baseline, deck state is a segmented spine.
- **The icons are drawn for this app**, not borrowed: one 24×24 grid, a 1.5
  stroke, square caps and mitred joins — the same drawing language as the
  keylines. They live as `<symbol>`s in a sheet at the top of `index.html`, so
  there is no icon font, no library and no extra request; a test fails if one is
  referenced without being drawn, or drawn without being used.

### Themes

Three complete palettes, plus an **Auto** that follows the device:

| | | |
|---|---|---|
| **Paper** | white stock | orange |
| **Linen** | warm off-white | deep teal |
| **Ink** | black stock | blue |

Brand accent is deliberately **separate from the semantic four** — `--danger`,
`--warn`, `--ok`, `--info`. That's what lets a theme take orange without its
brand colour colliding with the *Again* button, or take blue without merging
into *Easy*. The grade row, the deck spine and the quiz feedback read the same
in every theme; only the accent moves.

Adding a fourth is two edits: a palette block in `styles.css` and an entry in
`THEMES` in `js/config.js`. Tests enforce the contract — every theme must
restate every colour the default sets, may not invent tokens nothing else
defines, and cannot be offered in config without a palette to back it.

### Devices

One layout, four shapes — nothing changes what a component *is*, only where it
sits:

The nav is a **left rail at every width** — one `--rail` token drives its width,
the body offset and where toasts sit:

| | |
|---|---|
| **Small phone** (≤380px) | 52px rail, icons only; tighter gutters; the theme control drops its word |
| **Phone** | 64px rail, icons with labels under them |
| **Tablet** (≥600px) | 76px rail, roomier column |
| **Desktop** (≥900px) | 232px rail — labels beside icons, the wordmark at the top — and the index sets in two columns |
| **Landscape phone** | the rail earns its keep: no bottom bar eating height, so the card keeps the screen |

Hover styling is behind `(hover: hover) and (pointer: fine)`, so touch devices
never inherit a stuck hover state. Every control clears a 44px target on touch
sizes, and quiz results are marked with a glyph as well as a colour.

`tests/devices.mjs` drives all five views at eight viewport shapes — a 320px
phone through a 1680px desktop, including landscape — and fails on horizontal
overflow, a sub-30px tap target, or an icon that doesn't paint. It needs a
browser, so it sits outside `node --test`:

```bash
npx playwright install chromium
python3 -m http.server 8000          # serving vocab/
node tests/devices.mjs http://localhost:8000
```

## The three headline features

### 1 · Notifications

Two layers, either usable alone.

**Local reminders** (default, no backend). `js/notify.js` runs a one-minute
tick while a tab is open. When a reminder time passes it checks whether there
is anything worth interrupting for — cards due, or the daily goal unmet — and
only then raises a notification through the service worker, with **Review now**
and **In 1 hour** actions. Each slot fires at most once per day. Clicking the
notification focuses the existing tab and routes it to the right view.

**Web Push** (optional, needs the proxy). With VAPID keys set, the browser
subscription is stored server-side along with the learner's reminder times and
timezone offset, and `server/proxy.mjs` pushes on schedule — so reminders arrive
with every tab closed.

```bash
cd vocab/server
npx web-push generate-vapid-keys
# put both keys in .env, restart, then flip "server push" on in Settings
curl -X POST http://localhost:8787/api/push/test    # verify
```

Reminder copy lives in one function (`reminderCopy` in `js/notify.js`) — that's
the thing to rewrite first, because reminder wording is most of whether an app
like this is kept or deleted.

### 2 · Tracking

Every answer writes three things: the card's new schedule, the day's counters,
and a row in a rolling review log. Everything on the Progress tab reads from
those.

| Shown | Meaning |
|---|---|
| Streak | consecutive **local** days with ≥1 review (time on screen doesn't count) |
| Known words | cards that have graduated into review or mastered |
| Accuracy 7d | correct ÷ answered over the last seven days |
| Daily activity | 12-week heatmap, five intensity levels |
| Last 14 days | reviews per day |
| Deck mastery | new / learning / review / mastered / struggling |
| Forecast | cards scheduled to return over the next 7 days |

Cards failed five times are flagged **struggling** (leeches) and float to the
top of practice, and into the AI's weekly report.

The scheduler is a documented SM-2 variant: two learning steps (1 min, 10 min),
graduation at 1 day, ease between 1.3 and 3.5, ±5 % interval fuzz, capped at a
year. All of it is in `SRS` in `js/config.js` — change the numbers there, not in
the algorithm.

### 3 · AI

The browser **never** holds an API key. `js/ai.js` speaks to your own proxy;
`server/proxy.mjs` speaks to Claude.

| Feature | Route | Shape |
|---|---|---|
| Add a word → full study card | `POST /api/ai/word` | structured JSON |
| Generate a quiz item with real distractors | `POST /api/ai/quiz` | structured JSON |
| Suggest what to learn next | `POST /api/ai/suggest` | structured JSON |
| Mark a sentence the learner wrote | `POST /api/ai/coach` | streamed |
| Weekly progress write-up | `POST /api/ai/report` | streamed |

The JSON routes use **structured outputs** (`output_config.format` with a JSON
schema), so the browser gets a guaranteed shape and needs no defensive parsing.
The two conversational routes stream, and arrive token by token in the UI.
Default model: **`claude-opus-5`**, effort `low` — these are short, tightly
specified generations. `LEXIO_MODEL` overrides it; clients may request a model
only from an allowlist in `pickModel()`.

Prompts and schemas are all in `server/prompts.mjs`, under one shared tutor
system prompt. Re-target the app — a different language, an exam board, a
domain glossary — by editing that file and `js/data/seed.js`.

**Offline mode** (`mock`) is not a stub for the demo's sake: it keeps every
screen usable with no key, no network and no cost, and returns clearly-labelled
sample text so nobody mistakes it for a real definition.

## Customising

| Want to change | Edit |
|---|---|
| The starter deck | `js/data/seed.js` |
| Intervals, ease, leech threshold | `SRS` in `js/config.js` |
| Default goal, level, reminder times | `DEFAULTS` in `js/config.js` |
| Colours, spacing, radius | the palette blocks at the top of `styles.css` |
| Adding a theme | a palette in `styles.css` + an entry in `THEMES` (`js/config.js`) |
| Typefaces | `@font-face` block in `styles.css` + the files in `fonts/` |
| Tutor voice, output schemas | `server/prompts.mjs` |
| Reminder wording | `reminderCopy()` in `js/notify.js` |
| Persistence (→ IndexedDB, → a backend) | `read`/`write` in `js/store.js` |

## Testing

```bash
cd vocab && node --test            # scheduler, tracking + design system: 24 tests, no deps
cd server && npm run smoke         # every proxy route against a live server
```

## Deploying

The app is static — GitHub Pages, Netlify, S3, anything. The proxy is one Node
file with a single dependency; run it anywhere that runs Node 20+.

If you host them separately, set `ALLOWED_ORIGIN` on the proxy to your app's
origin (it defaults to `*` for local development) and point Settings → AI at
the proxy URL. If you run only the proxy, it serves the app too and there is
nothing else to configure.

## Data and privacy

Everything a learner does stays in their browser's `localStorage` under one
key. There are no accounts and no analytics. Settings → Export writes a JSON
backup; Import restores it. The only data that ever leaves the device is what
an AI call needs: the word, the sentence the learner wrote, or the aggregate
stats behind the weekly report — and only in proxy mode.

Clearing site data erases progress, so the Export button is not decorative.

## Known limits

- Local reminders need a tab open (that is the platform, not the app) — Web
  Push is the fix, and it needs the proxy.
- iOS raises notifications only for a PWA added to the home screen.
- Speech uses the browser's own voices; quality varies by platform.
- `localStorage` is synchronous and capped around 5 MB — comfortably thousands
  of words, but move to IndexedDB before shipping tens of thousands.
