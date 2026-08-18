# Lexio — English vocabulary app template

A complete, dependency-free starting point for a vocabulary learning app:
**spaced repetition**, **reminders**, **progress tracking** and **Claude AI**
already wired together and talking to each other.

No build step, no framework, no bundler. Open `index.html` and it runs.

```
vocab/
├── index.html          app shell
├── styles.css          design tokens + every component
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
└── tests/srs.test.mjs  scheduler + tracking tests (node --test)
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
| Colours, spacing, radius | the token block at the top of `styles.css` |
| Tutor voice, output schemas | `server/prompts.mjs` |
| Reminder wording | `reminderCopy()` in `js/notify.js` |
| Persistence (→ IndexedDB, → a backend) | `read`/`write` in `js/store.js` |

## Testing

```bash
cd vocab && node --test            # scheduler + tracking, 14 tests, no deps
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
