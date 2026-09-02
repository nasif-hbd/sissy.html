# VocabX — English vocabulary app template

A complete, dependency-free starting point for a vocabulary learning app:
**spaced repetition**, **reminders**, **progress tracking** and **Claude AI**
already wired together and talking to each other.

No build step, no framework, no bundler. Open `index.html` and it runs.

```
vocab/
├── index.html          app shell
├── styles.css          the design system: tokens, then every component
├── fonts/              Space Grotesk (vendored, 22 KB)
├── brand/              vocabx.png, the source logo
├── icons/              cut from it by scripts/build-icons.mjs
├── sw.js               offline cache, push + notification handling
├── manifest.webmanifest installable PWA
├── data/
│   ├── modules/        fourteen study packs + their manifest
│   └── dict/           117,845 words, sharded for lookup
├── scripts/
│   ├── build-modules.mjs   rebuilds both from the source workbook
│   ├── xlsx.mjs            a small read-only .xlsx reader, no dependencies
│   └── family.mjs          when two words are one word family
├── js/
│   ├── app.js          controller — wires DOM to the modules below
│   ├── catalog.js      module packs + dictionary lookup (lazy)
│   ├── placement.js    the adaptive level check (pure, testable)
│   ├── routine.js      the day's steps and their notification copy
│   ├── chat.js         reads an open question well enough to answer offline
│   ├── feedback.js     how a report is worded and addressed (pure)
│   ├── testlab.js      the Test section: five modes over two subjects
│   ├── install.js      what each platform can do about installing
├── desktop/            a 43 KB Windows launcher (one C file) and its build
│   ├── advice.js       turns a level into a study plan
│   ├── xp.js           the points economy, levels and rankings
│   ├── exam.js         question generation and marking
│   ├── lesson.js       one set of ten: cards, then the exam
│   ├── translate.js    six languages, dataset-first
│   ├── config.js       every tunable constant lives here
│   ├── store.js        persistence, schema, import/export
│   ├── srs.js          SM-2 scheduler (pure functions)
│   ├── stats.js        streaks, accuracy, heatmap, forecast
│   ├── notify.js       reminders (local) + Web Push (optional)
│   ├── ai.js           routes each call to the built-in tutor or the proxy
│   ├── local.js        the built-in tutor — every AI answer, on the device
│   ├── ui.js           rendering
│   └── data/seed.js    40-word starter deck — swap this out
├── server/             the only place an API key exists
│   ├── proxy.mjs       Node server: Claude routes + push + static app
│   ├── prompts.mjs     every prompt and output schema
│   ├── gemini.mjs      the Gemini half, over raw REST
│   └── smoke.mjs       hits each route and prints the wire shapes
└── tests/             scheduler, tracking and design-system tests
```

## Quick start

**Offline, right now** — every AI feature is answered on the device from the
dictionary that ships with the app, so nothing is required to try it:

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

`tests/devices.mjs` drives all ten screens at eight viewport shapes — a 320px
phone through a 1680px desktop, including landscape — and fails on horizontal
overflow, a sub-30px tap target, or an icon that doesn't paint. It needs a
browser, so it sits outside `node --test`:

```bash
npx playwright install chromium
python3 -m http.server 8000          # serving vocab/
node tests/devices.mjs http://localhost:8000
```

## How it works

Six tabs, named for what they do: **Home, Learn, Modules, Words, Progress,
Settings**. Practice sits behind a button on Home rather than taking a tab of
its own.

**Home** answers "what should I do now?" — today's reviews against the goal, a
Continue button for the set you were part-way through, then this week, this
month, the streak and the last seven days.

**Modules → a module → a set of ten** is the main path. Opening a module lists
its sets; opening a set walks the ten words one card at a time, then examines
you on them:

| Question | What it asks |
|---|---|
| **What it means** | the word is shown, pick the meaning |
| **Which word** | the meaning is shown, pick the word |
| **Fill the gap** | a real sentence with the word blanked out |

Everything is generated from the words themselves — no network, no AI — so
exams work offline and always cover the set you just studied. Wrong answers are
drawn from the same set first, which makes the test harder and fairer than
random unrelated words. *Fill the gap* needs a real example sentence, and only
429 words in the source data carry one, so most sets are examined on meaning and
recall.

Passing is 70%. Marks pay **10 XP per correct answer, +25 for a pass, +50 for
100%**, and the set's words join your review deck so spaced repetition takes
over. Exam answers count as reviews, so the daily goal, the activity chart and
the streak all move while you work through a module.

## Vocabulary

The app ships with a **117,845-word dictionary** and **fourteen study packs**,
both generated from the sectioned source workbook by `scripts/build-modules.mjs`:

```bash
node scripts/build-modules.mjs path/to/word_meanings_SECTIONED.xlsx
```

`scripts/xlsx.mjs` reads the workbook — the build has no dependencies, so it
parses the zip container and the sheet XML itself rather than pulling in a
spreadsheet library.

### What the workbook says, and what it doesn't

Nine sheets. Four of them — `NORMAL`, `INTERMEDIATE`, `ELITE`, `EXCEPTIONAL` —
partition every word exactly once, and they are a real difficulty ladder:
median synonym in-degree, the closest thing the data has to a frequency count,
falls 3 → 2 → 2 → 1 across them. Five more — `ACADEMICS`, `IELTS`, `SAT`,
`BD_ADMISSION_TEST`, `JOB` — mark what a word is studied for. A word's row is
byte-identical wherever it appears, so those five are pure labels.

Both facts used to be guesses. Difficulty came from a column that cut the old
CSV into four equal quarters; exam membership came from keyword rules run over
the definition, which is how `terrorist`, `admonition` and `acrobatics` ended up
in a Grade 1–5 pack. Neither survives contact with the workbook.

| Pack | | |
|---|---|---|
| **Grade 1–5** | A1–A2 | curated primary core, topped up from the everyday tier |
| **Grade 6–8** | A2–B1 | curated middle-school core, and the first abstract words |
| **Grade 9–10** | B1–B2 | the academic word list, everyday-and-common slice |
| **Grade 11–12** | B2–C1 | the academic word list, advanced slice |
| **University** | C1–C2 | the academic word list, rare slice |
| **IELTS General Training** | B1–B2 | the IELTS sheet minus its academic half |
| **IELTS** | B2–C1 | the IELTS sheet, academic end first |
| **SAT** | C1 | the SAT sheet, behind the classic curated list |
| **Admission (BD)** | B2–C1 | the admission sheet, then synonym/antonym drilling |
| **Job & Workplace** | B1–C1 | the JOB sheet, then interviews, email, contracts |
| **Native & Everyday** | A2–B1 | the plain words that make speech sound unforced |
| **Elite** | C2 | rare and literary |
| **Science & Medicine** | B2–C1 | labs, bodies and papers |
| **Compounds & Phrases** | B1–C1 | hyphenated and multi-word entries |

A pack is built in three passes: the **subject sheet** it is named after, then a
**curated core** where one adds something the sheet cannot, then a **top-up by
score**. Grade 9–10 upward is one list split three ways — `ACADEMICS` holds
every word school and university reading assumes, and which tier a word sits on
is how hard it is — so the three packs take a slice each and no word appears
twice. Nothing is hand-maintained after generation; re-run the script and the
packs rebuild.

`tests/packs.test.mjs` checks the result as data: no pack under 300 words, no
word or word family twice in a pack, no adult topic in a school pack, no two
packs more than 40% the same, and a school ladder that climbs.

### Filtering

The raw data is a scrape, and it shows. Every rule below exists because the
problem was counted first, and every rule's hits are tallied into
`data/quality-report.json` so the filtering is auditable rather than a matter
of trust.

**Repaired** — `(informal)` and `(law)`-style leading labels stripped (3,733),
definitions trimmed on a word boundary instead of mid-word (1,309),
`--Hippocrates` citation tails removed (1,076), backtick quoting normalised
(481), `; ; ;` runs collapsed (351), and 988 Bangla fields that were actually
English ("touchdown", "Odyssey") dropped for failing a script check.

**Rejected** — 39,233 headwords that aren't plain words (the workbook's everyday
tiers are more than half compounds and phrases), 3,937 taxonomic entries ("any
of various shrubs native to…"), 3,881 with nothing left after cleaning, 2,853
circular definitions, 1,114 too short, 559 inflections of a word already
present, 222 blocked as crude or explicit — this is a students' app — and 69
that aren't a sense of the word at all.

**Harvested** — 458 usage examples were hiding after a semicolon inside the
definition field and are now example sentences on the card.

Two rules took a second pass to get right, and both are worth knowing about:

- *Circular* first meant "the definition mentions the word", which threw away
  **"validate — declare or make legally valid"**. It now fires only when the
  headword's lemma appears **and** fewer than three other content words remain —
  so `exempt — grant exemption or release to` goes and `validate` stays.
- The **curated seeds bypassed cleaning entirely**, reading from the raw map, so
  `(informal) small and of little importance` kept reappearing no matter what
  the rules said. Seeds are looked up in the filtered pool now; 320 of them
  fail the rules and are dropped.
- *Not a sense of the word* is the newest and the smallest, at 69 rows, and the
  one a reader would have noticed. The workbook carries a single sense per
  headword, and for a handful of common words that sense is a slang list or a
  proper noun: **`grass` — "street names for marijuana"**, **`far` — "a
  terrorist organization that seeks to overthrow the government dominated by
  Tutsi"**. There is no better sense in the data to fall back to, so the entry
  goes rather than teach that one. A second rule keeps the school packs off
  adult topics, and it is matched on the headword and the definition separately
  — one combined rule also loses `terrible — causing fear or dread or terror`
  and `child — a young person of either sex`, which are exactly what a school
  pack wants.

Audited end to end, module words carrying a defect went from ~950 in 3,200 to
**0**.

### Frequency without a frequency list

The dataset has no frequency column, but it has a synonym graph: a word that
many other entries point at as a synonym is a central, ordinary word, and one
nobody points at is peripheral. That in-degree (median 1, 90th percentile 6, max
300) is the closest thing the data has to a frequency list, and it is what
separates *Native & Everyday* from *Elite*.

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

## XP and the leaderboard

Every action worth repeating pays, with the amounts set so the habit the app is
trying to build — a short session every day — pays better than one long session
a week:

| | |
|---|---|
| Review, correct / wrong | 10 / 3 — being wrong still pays, the point is to keep the cards turning |
| A new word graduating | 15 |
| Quiz / spelling answer | 8 / 12 |
| A sentence marked by the coach | 20 — writing is the hardest work, so it pays most |
| Daily goal met | 50, once a day |
| Streak | 5 × days, capped at 10, once a day |

Levels cost `100 + 60 × (level − 1)` XP each, so the first few come quickly and
then settle; titles run Beginner → Learner → Reader → Scholar → Linguist →
Wordsmith → Lexicographer.

The **leaderboard** ranks the two things a single learner can actually compete
against: which modules their XP is coming from, and their own best days. XP is
attributed to the module a word came from, so the board shows where the effort
is really going. It is all on-device — there are no accounts and nothing is
sent anywhere.

## The home screen

Home answers four questions, in the order a learner asks them.

**What do I do now?** The Today card: reviews done against the daily goal, and
one primary button that names what pressing it will actually do — "Review 2
words", "Learn 10 new words", "Study ahead". The goal counter and the button
measure different things (the day's target, and the queue waiting), so each
names its own unit; unlabelled beside each other they read as a bug.

**Am I keeping it up?** The streak, over seven day marks. A week with two study
days looks like a week with two study days — the bar chart this replaced looked
identical to an empty one, and sat beside a "Streak: 0" tile saying the same
thing twice.

**Where do I stand?** The XP level earned, and the CEFR level measured by the
check — two different things, so both are named. The CEFR badge stays hidden
until the check has been sat; a large "?" next to "Level 3" read as though the
XP level were the unknown one.

**What am I working on?** The modules with work in them, most recently touched
first, each with its passed-set count, plus one Continue button for the set left
part-way through. Home never showed this before, though module → set → exam is
the loop the whole app is built around.

Under it, one line for the longer view — reviews this month, accuracy, best
streak. It replaced four stat tiles that on a fresh install all read "0", and it
deliberately repeats neither the header (words, learned) nor the card above it
(current streak).

## The Test section

Five ways to be examined, on two subjects, over fourteen word packs.

**Two subjects.** Vocabulary tests the packs; Grammar tests a bank shipped with
the app — 200 items across 37 topics from present simple to participle clauses, each
carrying the rule it tests, so a wrong answer is explained without an API call.

**Five modes**, chosen because they are genuinely different demands rather than
one question dressed five ways: recognition (flashcards), discrimination
(quiz), production in context (in a sentence), sustained recall under a mark
(written exam) and orthography (spelling). A learner can pass a quiz on a word
they cannot spell or use in a sentence. Spelling is offered for vocabulary only
— "spell this grammar rule" is not a thing, and the picker does not pretend
otherwise.

**Fourteen packs in three groups.** School runs Grade 1–5 through University;
Exams covers IELTS, IELTS General Training, SAT and Admission (BD); Work & life
holds the rest.

The school packs were the hard ones. There is no grade column in the data, so
level is inferred from difficulty band and synonym centrality — a word many
entries point at as a synonym is one children meet early. That alone was not
enough: the default scorer rewards well-documented entries, which is a property
of a good dictionary rather than an easy word, and Grade 1–5 filled up with
"terrorist", "admonition" and "acrobatics". The lower grades now carry a
curated core of about 500 words each and rank by simplicity; the upper ones
rank by the scorer but filter out roman numerals, initialisms and place names,
which is what "xii", "nsu" and "uzbeg" were doing in Grade 9–10.

`js/testlab.js` holds everything that decides what a question is, and
`tests/testlab.test.mjs` pins the parts that fail silently: a spelling prompt
must never contain the word it asks for, a synonym item must never offer a real
synonym as a wrong answer, and a flashcard round must not be scored 0%.

## Ask — the tutor you can talk to

Everywhere else the AI answers a question the app chose. The Ask tab lets the
learner choose, which is a different job: they arrive with "what's the
difference between affect and effect", or a sentence they are unsure of, and no
menu covers that.

With Claude connected the conversation (last twelve turns) goes to
`POST /api/ai/ask`, streamed. Without it, `js/chat.js` reads the question well
enough to answer the common shapes from the dictionary already on the device —
"what does X mean", "X vs Y", "use X in a sentence", "synonyms for X" — and says
plainly when a question is beyond that rather than inventing an answer.

The parsing is the part that can fail silently: mis-read the question and it
confidently answers a different one. `tests/chat.test.mjs` pins it, including
that an open question yields *no* word rather than a wrong one, so it falls
through to Claude instead of being answered about some stray token.

## Installing it

Three ways in, and the app offers whichever one the visitor's device can
actually do.

**The landing page** (`/index.html`, the site root) reads the platform and
shows one route: an Install button where the browser gives us a real
`beforeinstallprompt`, Share → Add to Home Screen on iOS, File → Add to Dock on
Safari, the ⋮ menu on Android, and the Windows download alongside on Windows.

**Inside the app**, Settings carries the same offer permanently, and Home shows
it once — dismissible, and the dismissal sticks. Nobody wants to be asked twice.

**One button, named for the device holding it.** `installOffer()` turns the
detected platform into the single thing that will actually happen there:
*Download for Windows*, *Add to your iPhone*, *Install on your Android phone*,
*Install on your Chromebook*. The word "Download" appears only where a file
exists — which the caller decides, by passing the href it actually ships, not
the module by assuming. On iOS that word would promise something Apple has no
route to deliver, so the label says "Add" and the steps say why. Where a
platform has both a file and a prompt, the file leads and the prompt is the
second, smaller option; a button that opens the browser's install dialog is
never labelled "Download", because that is not what pressing it does.

Every card that carries the offer follows the same rule, so the heading, the
button and the link can never name three different things: Home, the sidebar,
Settings, and the landing page all render from one `installOffer()` result.
Settings also keeps a closed *Installing on another device* section — for
putting it on the family PC from a phone, or on a phone from the PC.

`js/install.js` does the detection, and both `platformOf()` and
`installOffer()` are pure, so every branch is tested against real user-agent
strings. The branches matter more than they look:
one "Install" button everywhere silently does nothing for everyone on
Safari and Firefox, and a captured `beforeinstallprompt` is trusted over the
user agent because the event is proof where the string is a guess. Three traps
the tests hold shut — an iPad reports itself as a Mac and is caught by its
touch points; Chrome on iOS is Safari underneath and still cannot add to the
Home Screen; and Safari installs through Add to Dock, so pointing a Safari user
at Chrome's address-bar icon sends them hunting for a button that is not there.

## Windows desktop build

`desktop/` holds a 43 KB native launcher. Double-clicked, it serves the app on
loopback and opens the browser at it — one small binary rather than a second
copy of the app that drifts out of step with the web one.

    cd desktop && ./build.sh          # needs mingw-w64; cross-compiles from Linux

It serves only the `app` folder beside it, binds only to 127.0.0.1, and
uploads nothing. The path resolver is the security boundary: a decoded request
is rejected if it contains a parent-directory step, a drive letter or a
backslash, and the canonicalised result must still sit under the app root.
Content types matter more than they look — a browser refuses to execute an ES
module served as `text/plain`, so a wrong type there is a blank page rather
than a slow one.

It is not code-signed, so SmartScreen will warn on first run. That is worth
saying plainly rather than hiding: anyone who would rather not run an unsigned
binary can use Edge or Chrome's "Install this site as an app" instead and get
the same desktop icon, window and offline support.

## Feedback

A floating button on every screen. Each report carries the screen, the engine,
the level and the viewport size, which is what turns "the quiz is broken" into
something reproducible; it carries no deck contents and nothing identifying.
There is no third-party form and no analytics, because this app collects nothing
and a feedback button is not a good reason to start.

There are three routes out, and which ones are open depends on what is running:

| | Needs | Where it lands |
|---|---|---|
| **Send** | a proxy | `server/feedback.jsonl`, and an email if SMTP is set |
| **Send by email instead** | nothing | the reader's own mail app, addressed to `APP.feedbackTo` |
| **Copy it instead** | nothing | the clipboard |

The middle one exists because the hosted build has no server behind it, and
"Send" there could only ever write the note to the device the note came from —
which reads as sent and is not. The button that says so now says so plainly.

### Getting it as email

Set five things in `server/.env` and the proxy forwards each report as it
arrives:

```bash
FEEDBACK_TO=you@example.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465            # TLS from the first byte; 587 uses STARTTLS instead
SMTP_USER=you@gmail.com
SMTP_PASS=…              # Gmail: an App Password, not your login password
```

Gmail needs 2-Step Verification on, then a 16-character App Password from
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) —
a normal password is refused, and `SMTP_FROM` has to be the account that logs
in. Leave the block out and nothing breaks: the note still lands in
`feedback.jsonl`, which is the record; the email is only the notification.

`server/mailer.mjs` is a small SMTP client written rather than installed, for
the same reason as the rest of this server: the proxy holds your API keys, and
every dependency added to it is another package that can read them. Three
things in it are worth knowing:

- **The file write happens before the send, and the send is never awaited.** A
  wrong password loses a notification, not somebody's bug report.
- **A password is never written to a socket that is not encrypted.** Port 465
  is TLS from the first byte; on any other port the client requires the server
  to advertise STARTTLS and refuses to authenticate if it does not. There is a
  test that watches the wire to confirm nothing leaks when it refuses.
- **The protocol is split from the transport** (`speakSmtp` and `sendMail`), so
  the whole conversation — EHLO, AUTH LOGIN, the base64 halves, MAIL FROM, DATA,
  dot-stuffing, QUIT — is exercised against a fake server without needing a
  certificate.

## Your routine, and words on the lock screen

Reminders used to be a flat list of times that all showed the same nag. A
routine is that list with intent attached: what happens at 07:30 is a different
thing from what happens at 21:00, and the notification says so.

Each step is a time plus one of six actions — review what is due, carry on a
module, practise, **a word on the lock screen**, **a line to keep going**, or
**surprise me**. Steps are edited in place in Settings, sorted by time, and
each carries its own copy and its own destination when tapped.

**On the lock screen.** A web app cannot draw a lock-screen widget on any
platform — that needs a native app, and this is deliberately not one. What it
can do is fire a notification, and a notification lands on the lock screen on
Android and iOS and in the notification centre on Windows and macOS. A
notification carrying a word and its meaning does the job a widget would:

    resilient
    (adjective) able to recover quickly from difficulty

**Surprise me** rotates through six kinds so the card is worth reading twice:
the word and its meaning, its Bangla and Hindi, a synonym pair, a question to
answer in your head, a note on how its part of speech behaves, or a line to
keep going. Two kinds was not variety — the same two things at the same two
times every day stops being read. Any kind with nothing to show for the word it
drew falls through to the next, because a card reading "resilient — undefined"
is worse than no card.

    resilient ≈ tough          notion ≈ idea
    Also: hardy, adaptable.    Also: concept, impression.

    What does "concise" mean?  undermine
    Think of it, then open      A verb. Check what it takes as an
    VocabX to check.             object before you use it.

The passive step types drop the action buttons — they are things to read, not
tasks. `ACTIONS.surprise` is marked `varies`, because unlike the others it has
no single destination: a word card opens Learn, a quote opens Home. A test
caught that inconsistency when the field still claimed one fixed view.

**When they arrive.** Local reminders fire while a tab is open; that is the
platform, not a limitation of the app, and the builder says so under the list
rather than letting someone rely on a 07:00 card that never comes. With the
proxy running and VAPID keys set, the same routine is pushed server-side and
arrives with the app closed. The push scheduler imports `cardFor` from
`js/routine.js` — the same function the in-app reminder uses — so the wording
cannot drift between the two paths. The server never receives the learner's
deck: a pushed word card is drawn from the module packs it already hosts.

`tests/routine.test.mjs` covers the firing rules, because a reminder that fires
twice, at the wrong hour, or silently never is the kind of bug nobody reports
and everybody resents.

## The level check

The learner used to pick their own CEFR level from a dropdown, which is a guess
dressed up as a setting — and it decides how hard every definition, suggestion
and module recommendation is. `js/placement.js` measures it instead.

**How it measures.** Every word in the module packs carries the dataset's own
difficulty band (Easy / Moderate / Advanced / God Level ⇒ A2 / B1 / B2 / C2), so
a question drawn from a band is a question of known difficulty. A sitting is
sixteen questions in two halves:

1. **A calibration sweep** — two questions at each band, in order. This is what
   makes every band judgeable. Without it a strong learner reaches the top rung
   by question three and spends the other thirteen there, leaving every other
   band on a single item and reporting a flawless score as "provisional".
2. **An adaptive ladder** — the remaining eight. Right answer, harder band;
   wrong answer, easier. It hands over one rung above the hardest band the sweep
   saw passed, so it spends its questions on the boundary rather than
   re-confirming settled ground.

Questions come in three kinds — what a word means, which word means this, and
which word is closest in meaning. **Every distractor is drawn from the answer's
own band.** That is the property the whole measurement rests on: mix bands and a
rare word becomes answerable by elimination against three everyday ones, and the
ladder measures nothing. `tests/placement.test.mjs` fails if that ever breaks.

**What it reports.** The level is the hardest band answered at 70% or better
over at least two items — a single lucky answer never earns a band. Confidence
falls when few bands got enough questions to judge, and the screen says so
rather than implying a precision sixteen questions cannot support. The
vocabulary figure is measured accuracy per band applied to the words *this app
holds* in that band, and is labelled as exactly that — never as the learner's
total English vocabulary.

**What it does about it.** `js/advice.js` turns the result into a plan: a level,
a daily goal, new words per day, the three modules that fit, and any of the
learner's own words that keep coming back wrong. One button applies it.

Modules are ranked by where their difficulty sits relative to the learner: a
module pitched just above them scores highest, one entirely below is revision,
one entirely above is discouraging. Pace comes from review accuracy once there
is a week of it; before that it comes from *whether and how high they placed* —
never from their exam score, because an adaptive exam drives every learner
towards roughly half right and using that would tell everyone to slow down.

The plan is computed on the device in both AI modes, so the recommendation is
identical with or without a key. Claude writes the read-out around it (`/api/ai/assess`)
and is told the level and plan as fixed inputs to explain — it cannot quietly
overrule a measurement with a hunch.

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
| Level check → written read-out | `POST /api/ai/assess` | SSE stream |
| An open question, with history | `POST /api/ai/ask` | SSE stream |
| Generate a quiz item with real distractors | `POST /api/ai/quiz` | structured JSON |
| Suggest what to learn next | `POST /api/ai/suggest` | structured JSON |
| Mark a sentence the learner wrote | `POST /api/ai/coach` | streamed |
| Weekly progress write-up | `POST /api/ai/report` | streamed |

The JSON routes use **structured outputs** (`output_config.format` with a JSON
schema), so the browser gets a guaranteed shape and needs no defensive parsing.
The two conversational routes stream, and arrive token by token in the UI.
### Two engines, one rule

The app can run on **Claude** or **Gemini**, chosen in Settings, and every AI
surface uses whichever is picked. Both go through your proxy, and the rule does
not change with the vendor: **an API key in the browser is a key every visitor
can read and spend.** `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` live on the
server; the browser sends only which engine it wants, and the proxy honours it
only if it holds that key — so a client set to Gemini against a Claude-only
server gets a clear error rather than a silent switch to a model nobody chose.

Gemini goes over raw REST (`server/gemini.mjs`) rather than a package: the two
calls this app makes are a JSON request and an SSE stream, and a dependency for
that is a worse trade than thirty lines of fetch. Its structured-output support
rejects the JSON-Schema keywords it does not implement, so schemas are trimmed
before they are sent. Errors are scrubbed before they are forwarded, because the
Gemini key travels in the URL and an unedited error echoes it back.

Default model: **`claude-haiku-4-5`** — the cheapest tier, and the right one
here. Every call is short and tightly specified: a definition, one quiz item, a
paragraph of feedback. At $1/$5 per million tokens it is a fifth of Opus 5's
input price. Settings offers Sonnet 5 and Opus 5 for anyone who wants them, and
`VOCABX_MODEL` overrides the default; clients may only request a model from the
allowlist in `pickModel()`.

One trap worth knowing if you change the model: **`output_config.effort` is
rejected outright by Haiku 4.5 and Sonnet 4.5.** Sending it anyway turns every
route into a 400. `outputConfig()` in `proxy.mjs` gates it by model, so the
parameter goes only to models that take it.

Prompts and schemas are all in `server/prompts.mjs`, under one shared tutor
system prompt. Re-target the app — a different language, an exam board, a
domain glossary — by editing that file and `js/data/seed.js`.

**The built-in tutor** (`mock`) is not a stub for the demo's sake. `js/local.js`
answers each route from the 117,845-entry dictionary and the study packs already
on disk: real definitions and synonyms for the explain panel, real words at the
learner's band for suggestions, checkable feedback on a written sentence, and a
weekly summary written from the tracking numbers. No key, no network, no cost —
and no placeholder telling the learner to go and configure a server first. Claude
is what you turn on for prose that is written fresh for the learner, not for the
app to become usable.

## The logo

`brand/vocabx.png` is the source artwork and the only file to replace. Running
`scripts/build-icons.mjs` cuts everything else out of it:

| | | |
|---|---|---|
| `mark-512.webp` | 12.5 KB | manifest, including the maskable entry |
| `mark-192.webp` | 4.4 KB | manifest, and the notification icon |
| `mark-64.webp` | 1.7 KB | the header and the nav rail |
| `mark-180.png` | 30.5 KB | the iOS home-screen icon |
| `mark-32.png` | 1.6 KB | favicon |
| `lockup-400.webp` | 9.1 KB | the landing page, where there is room for all of it |

Three decisions are baked into that script, and each one was measured.

**The small icons are the mark alone.** The logo is a lockup — the book-and-X
above the word "VocabX" above a tagline — and at 32 pixels in a browser tab the
words are mud. The script finds the mark rather than being told where it is: it
counts ink per row, takes the widest empty band below the artwork as the split,
and crops to everything above it, so a re-exported logo with different margins
still works. The crop is recomposed on the ground colour sampled from the
source's own corner, at 74% of the frame, which clears the 80% safe zone a
maskable icon is cropped to.

**WebP, not PNG.** This artwork is a smooth gradient render, which is the case
PNG is worst at: the 512 is 265 KB as a PNG and 12.5 KB as WebP. The app's
entire first load is 133 KB, so shipping the PNG would have doubled it for one
icon. PNG stays for the two places with a reason — the iOS home-screen icon and
a favicon fallback.

**Chromium does the resampling.** There is no ImageMagick on the machines this
builds on, and a native image dependency was not worth adding to a build that
has none. Playwright is already here for the device sweep, and a canvas
resamples correctly.

## What a second look found

Everything below is a measurement, not an impression, and each one is followed
by what was done about it.

**The grammar bank was three sittings deep.** 54 questions, and seventeen of its
twenty-eight topics carried exactly one — pick Grammar in the Test tab twice and
you were answering the same items. It is 200 questions across 37 topics now,
with a floor of four per topic that `build-grammar.py` asserts and
`tests/grammar.test.mjs` re-checks against the shipped file. The new items are
written, not generated: a model asked for 150 grammar questions produces
plausible ones with two defensible answers, and two of the first draft's
prompts collided with items already in the bank — which the builder caught.

**Six controls had no name.** A screen reader met the Words filter, the routine
time and action pickers, the sentence box and the word box as "edit text", and
"edit text" again. A placeholder is not a label. All of them are named now.

**The navigation never said where you were.** Eight `<button class="tab">` with
a CSS class for the active one and nothing else — no `aria-current`, no way to
tell. The class is still the paint; `aria-current="page"` is the part that is
read. Switching a tab also moves focus into the view, or the next Tab press
walked back through the whole nav.

**Nothing was announced.** One live region existed, for toasts. Grading a card
writes nothing to the screen at all — the card simply turns — so a screen-reader
user got silence. There is an announcer now, and grading says which button was
pressed, when the word returns and how many are left. `spokenDelta` exists
because "3d" is right on a button face and is not a length of time out loud.

**The keyboard worked and never said so.** Space, 1–4 and S have always driven a
review; nothing in the interface mentioned them. The Test tab had no shortcuts
at all, so a forty-question round was forty trips to the mouse. Both screens
show their keys now, hidden on touch, and Test answers to 1–4 and Space.

**A misgrade was permanent.** Pressing Easy on a card you did not know is the
commonest mistake anyone makes with spaced repetition, and it costs a month.
Grading writes to six places — schedule, day counters, streak, XP, log, queue —
so undo copies the four parts of state they touch and puts them back rather
than reversing each write; the streak in particular cannot be recomputed from
what survives. Twelve seconds to take it back, by button or `Z`.

**A fortnight away meant a wall of four hundred.** `buildQueue` returned every
due card, so the Today card promised twenty reviews and the next screen handed
over four hundred — the point at which people stop. A session now stops at 60,
oldest first, and Home says so: *400 words are overdue. This session takes the
60 oldest; the rest follow over the next few days.* Nothing is skipped, only
postponed. Learning cards are never held back; they are minutes away.

**The load is 133 KB, not 366 KB.** Measured against a plain `http.server` the
app looks three times heavier than it is, because GitHub Pages serves gzip and
`python3 -m http.server` does not. Compressed, over emulated slow 3G with a 4×
CPU throttle, the app is usable in 4.5 seconds: 79 KB of JavaScript, a 22 KB
font, 11 KB of CSS, 9 KB of HTML. The starter deck, 6 KB of that, was being
fetched on every load to be used on exactly one — it is a dynamic import now,
read only when there is no saved deck. Deferring the tab-only modules
(`placement`, `testlab`, `chat`, `local`) would save about 15 KB more; that is
eight call sites in a 1,787-line file for roughly half a second, and it has not
been done.

**Nothing to report on two counts.** There is no `innerHTML` anywhere in the
app, so there is no HTML-injection surface to audit. Offline is complete: with
the network cut and the page reloaded, the app boots, dictionary lookups
resolve and an unopened pack still loads.

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
| The app mark | replace `brand/vocabx.png`, then `node scripts/build-icons.mjs` |
| Tutor voice, output schemas | `server/prompts.mjs` |
| Reminder wording | `reminderCopy()` in `js/notify.js` |
| Persistence (→ IndexedDB, → a backend) | `read`/`write` in `js/store.js` |

## Testing

```bash
cd vocab && node --test tests/*.test.mjs   # scheduler, undo, tracking, design, XP, exams, tutor, placement, routine,
                                           # chat, test lab, install, packs, grammar, feedback, mailer, xlsx: 228 tests, no deps
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
- The level check measures against the 5,823 banded words in the study packs,
  not the full 117,845-entry dictionary — only the packs carry difficulty bands.
  Sixteen questions place a learner within a band, not to a fraction of one, and
  the result screen says so instead of implying otherwise.
