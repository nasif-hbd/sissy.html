# Lexio — English vocabulary app template

A complete, dependency-free starting point for a vocabulary learning app:
**spaced repetition**, **reminders**, **progress tracking** and **Claude AI**
already wired together and talking to each other.

No build step, no framework, no bundler. Open `index.html` and it runs.

```
vocab/
├── index.html          app shell
├── styles.css          the design system: tokens, then every component
├── fonts/              Space Grotesk (vendored, 22 KB)
├── sw.js               offline cache, push + notification handling
├── manifest.webmanifest installable PWA
├── data/
│   ├── modules/        eight study packs + their manifest
│   └── dict/           95,000 words, sharded for lookup
├── scripts/
│   └── build-modules.mjs   rebuilds both from the source CSV
├── js/
│   ├── app.js          controller — wires DOM to the modules below
│   ├── catalog.js      module packs + dictionary lookup (lazy)
│   ├── translate.js    six languages, dataset-first
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

Soft and quiet: white cards on a tinted desk, generous corner radii, shadows
you notice only when they're gone, and a pastel wash behind anything that needs
emphasis — the memory hook, an AI note, a right or wrong answer. The chrome
stays out of the way so the word on the card is the loudest thing on screen.
There is no emoji: every mark is a drawn icon from the sheet in `index.html`.

Three decisions carry most of it:

- **One vendored face.** Space Grotesk (22 KB, in `fonts/`) carries headings,
  numbers and controls; body copy uses the system UI font, which is the
  friendliest and fastest thing on any device. No third-party request, no flash
  of fallback text, and it all still works offline.
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
| **Paper** | white | orange |
| **Linen** | warm off-white | teal |
| **Ink** | black | blue |

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

## Vocabulary

The app ships with a **95,000-word dictionary** and **eight study modules**,
both generated from a source CSV by `scripts/build-modules.mjs`:

```bash
node scripts/build-modules.mjs path/to/word_meanings_dataset.csv
```

| Module | | |
|---|---|---|
| **IELTS** | B2–C1 | academic vocabulary that carries marks in Writing Task 2 |
| **SAT** | C1 | the judgement-and-degree words American college tests reuse |
| **Admission (BD)** | B2–C1 | synonym/antonym drilling for Bangladeshi admission tests |
| **Job & Workplace** | B1–C1 | interviews, email, contracts |
| **Native & Everyday** | A2–B1 | the plain words that make speech sound unforced |
| **Elite** | C2 | rare and literary |
| **Science & Medicine** | B2–C1 | labs, bodies and papers |
| **Compounds & Phrases** | B1–C1 | hyphenated and multi-word entries |

Each is 400 words: a **curated core** for the subject — the words that genuinely
belong on an IELTS or SAT list — topped up from the dataset by a score that
rewards real synonyms, a usable definition and shipped translations. Nothing is
hand-maintained after generation; re-run the script and the packs rebuild.

Two things follow from shipping the whole dictionary:

- **Adding a word rarely needs the network.** Type one in the Index and it is
  looked up locally first; the AI is the fallback, not the default. Lookups
  fetch a single shard (two letters deep, three where a bucket got fat, so no
  shard exceeds ~160 KB) and nothing is loaded at boot.
- **Bangla, Hindi and Mandarin are free and offline** — they come with the data.

## Translation

Six languages: **Bangla, Hindi, Spanish, Arabic, Mandarin, Russian**. Set one in
Settings and every card carries the word in that language under its definition.

Three sources, cheapest first: the dataset (instant, offline, no cost), the
on-device cache (each word is translated once per device), then **Google
Translate**. The page can call Google's public endpoint directly — it answers
with CORS open — or route through the proxy's `/api/translate`, which is what
you want in production: one place to rate-limit and to add a key.

That endpoint 500s intermittently. Both paths retry three times with a short
backoff, which took Spanish from roughly two failures in five to **8/8** in
testing; every request also has a 7-second deadline, so a blocked network hides
the line instead of leaving an ellipsis on the card.

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
| The modules and dictionary | edit `MODULES` in `scripts/build-modules.mjs`, re-run it |
| Translation languages | `LANGUAGES` in `js/translate.js` |
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
