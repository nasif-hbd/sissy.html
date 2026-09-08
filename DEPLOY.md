# Deploying VocabX

Everything here happens in the Cloudflare dashboard. No terminal, no CLI, no
build step — the app is HTML, CSS, ES modules and JSON, and Cloudflare serves
files.

Read Part 0 first. It is one decision, and every other part depends on it.

---

## Part 0 — Which shape

VocabX is two things: an app, and an AI proxy that holds your API keys. They
can be one deployment or two, and that choice decides everything below.

### Shape A — one upload

`vocabx-pages-with-ai.zip`. Pages serves the app **and** runs the AI, on one
address.

- One thing to deploy, one thing to configure, one URL.
- No CORS, no `ALLOWED_ORIGIN`, no proxy address to paste into Settings — the
  app in this archive talks to whatever origin it was served from.
- The D1 database binds to the Pages project.

### Shape B — two pieces

`vocabx-web.zip` on Pages, `worker.js` as a Worker of its own.

- **This is what is live today.** The app in `vocabx-web.zip` is built pointing
  at `https://vocabx-proxy.mdmukul666343.workers.dev`.
- Needs `ALLOWED_ORIGIN` on the Worker, matching your site's address exactly.
- The D1 database binds to the **Worker**, not to Pages.

**Which to pick.** Shape B if the Worker already exists and works — you are
one paste from being current. Shape A if you are setting this up again from
scratch, or if the two addresses have ever got out of step, because it removes
the whole class of problem.

You cannot half-do this. Two origins need `ALLOWED_ORIGIN`; one origin must not
have it. Pick one and follow that column.

---

## Part 1 — Get the files onto Pages

### If your Pages project is connected to GitHub

Then there is no upload. Cloudflare deploys whatever is on the **production
branch**, which is `main`.

The current work is on `claude/english-vocab-learning-app-ub3m1v`. Nothing
deploys until that reaches `main`:

```
git checkout main
git merge claude/english-vocab-learning-app-ub3m1v
git push origin main
```

A deploy takes about a minute. Skip to Part 2.

> A Git-connected project cannot take a zip. If you want to drag files in
> instead, you need a direct-upload project — see below — and then to move the
> custom domain across.

### If you are uploading the zip

1. **Compute (Workers & Pages) → Create → Pages → Upload assets.**
2. Project name: `vocabx`. **Create project.**
3. Drag in **`vocabx-pages-with-ai.zip`** (Shape A) or **`vocabx-web.zip`**
   (Shape B). Cloudflare unpacks it; the archive's root is the site root, which
   is why `index.html` is at the top level of it and not inside a folder.
4. **Deploy site.**

To update later: same project → **Create deployment** → drag the new zip in.
Every previous deployment stays in the list, and **Rollback** on one of them
undoes a bad release immediately.

You get `vocabx.pages.dev`. Open it before touching DNS, so that if something
is wrong you know it is the deploy and not the domain.

---

## Part 2 — The domain

Skip if `vocabx.ylarena.online` already points here.

1. The domain must be on Cloudflare first: **Add a domain** → `ylarena.online`
   → Free plan → check the scanned DNS records against what the domain does
   today. **If email runs on this domain, confirm the MX and TXT records came
   across** — a missing MX record is how a domain move quietly stops mail.
2. Replace the nameservers at your registrar with the two Cloudflare gives you.
   Wait for **Active**.
3. Pages project → **Custom domains** → **Set up a custom domain** →
   `vocabx.ylarena.online` → **Activate domain**. The DNS record is made for
   you.
4. Wait for *Initializing* → **Active**. Usually a minute; up to fifteen while
   the certificate issues.

HTTPS is automatic. Nothing else to configure.

---

## Part 3 — The AI proxy

### Shape A — nothing to deploy

`_worker.js` is already inside the archive you uploaded. Pages found it and is
running it. Go to Part 4.

### Shape B — paste the Worker

1. **Workers & Pages → Create → Start with Hello World → Deploy.**
   Name it `vocabx-proxy` (the name is in the URL, and the app is built
   pointing at `vocabx-proxy.mdmukul666343.workers.dev`).
2. **Edit code.** Select all, delete, paste the whole of **`worker.js`**.
   **Deploy.**
3. **Settings → Variables and Secrets → Add:**

   | Type | Name | Value |
   |---|---|---|
   | Variable | `ALLOWED_ORIGIN` | `https://vocabx.ylarena.online` |

   No path, no trailing slash, and it must match the address in the browser bar
   exactly. Without it the Worker answers anyone who finds the URL, and they
   spend your API credit.

To update the Worker later: **Edit code**, select all, paste the new
`worker.js`, Deploy. That is the whole update.

---

## Part 4 — The Gemini keys

Where they go depends on the shape:

- **Shape A:** Pages project → **Settings → Variables and secrets** → the
  **Production** environment.
- **Shape B:** the Worker → **Settings → Variables and Secrets**.

Two ways to add them. Either works; do not do both.

**One secret, all the keys** — fewer clicks:

| Type | Name | Value |
|---|---|---|
| Secret | `GEMINI_API_KEYS` | `AIzaKey1,AIzaKey2,AIzaKey3` |

Note the **S** on the end. Commas or line breaks between them; spaces are fine.

**One secret each** — easier to change one later:

`GEMINI_API_KEY`, then `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3` … up to
`GEMINI_API_KEY_10`. All Secret type. The numbering starts at 2; there is no
`_1`.

Then **Deploy** (Shape B) or **redeploy** (Shape A — Pages applies new
variables on the next deployment, so use **Retry deployment** on the latest
one).

**Why several.** Gemini's free tier is metered per key, so ten keys is ten
times the daily quota. The proxy stays on one key until that key is genuinely
finished — 429 quota, 403 disabled, or 400 with `API_KEY_INVALID` — then moves
to the next and stays there. It does not rotate per request; spreading requests
evenly would exhaust all ten on the same day instead of one.

Keys from **separate Google accounts** have separate quotas. Several keys in
one account may share that account's quota, which defeats the point.

---

## Part 5 — The database, for accounts and sync

Skip it and the app still works completely — every word, every screen, every
feature, kept on the device. This only adds the server copy, sign-in, and
carrying progress to a second device.

1. **Storage & Databases → D1 SQL Database → Create database.**
   Name: `vocabx`. **Create.**
   There are no tables to make. They are created the first time somebody signs
   up or saves.

2. Bind it:

   - **Shape A:** Pages project → **Settings → Bindings** → **Add → D1
     database**.
   - **Shape B:** the Worker → **Settings → Bindings** → **Add → D1 database**.

   | Field | Value |
   |---|---|
   | Variable name | `DB` |
   | D1 database | `vocabx` |

   **`DB`, exactly, capitals included.** `db` or `Database` will bind
   successfully and do nothing.

3. Deploy / redeploy.

**It is free.** D1's free tier is 5 GB and 5 million reads a day; a learner's
snapshot is a few kilobytes.

**There is no password reset** — nothing is emailed, because there is no mail
server here. A forgotten password means the saved copy is unreachable; the work
on the device is untouched. Say so to anyone you set this up for.

---

## Part 6 — Check it, in one place

Open this in any browser:

- **Shape A:** `https://vocabx.ylarena.online/api/health`
- **Shape B:** `https://vocabx-proxy.mdmukul666343.workers.dev/api/health`

Four things to read:

```json
{
  "accounts": { "rounds": 250000, "tries": 8 },
  "providers": {
    "gemini": { "ready": true, "keys": 10, "model": "gemini-flash-lite-latest" }
  },
  "sees": ["ALLOWED_ORIGIN", "DB", "GEMINI_API_KEYS", "..."]
}
```

| What it says | What it means |
|---|---|
| `"keys": 10` | Ten keys are readable. Added five and it says one? A name is misspelled — that number exists to show you exactly this. It never shows the keys. |
| `"gemini": { "ready": false }` | No key is readable at all. Check the environment you put it in: on Pages, Production and Preview are separate. |
| `"accounts": false` | The database is not bound. The app hides the sign-in buttons rather than showing a form whose last step fails. Check the variable name is `DB`. |
| `sees` lists names only | Never values. A key in the wrong field, the wrong environment, or the wrong Worker all look identical from outside — "no key set" — and this is what tells them apart. |

Then open the app itself: **Settings → AI help**. The engine line says which
engine answered and why. An answer signed *Built-in tutor* means the live
engine could not be reached, and the reason is on the same line.

**Shape B only:** Settings → AI help → **Your server** must hold the Worker's
https address. **Shape A: leave it empty** — empty means "the same address this
app came from", which is the whole point of that shape.

---

## Part 7 — Everything else

**The desktop build.** `vocabx-desktop.zip` is not deployed; it is downloaded.
The landing page already links to it, and the packaging step put a copy inside
the site archive at `/download/vocabx-desktop.zip`, so that button works as
soon as the site is up. Nothing to configure.

**Android.** `vocabx-android-source.zip` is a TWA wrapper — a Play Store
shell around the hosted site. It needs Android Studio and a Play Console
account, and it points at whatever domain you deployed above, so deploy first.

**`_headers`** is in the archive and Pages applies it: the typeface cached for
a year, word packs for an hour, and `sw.js` never cached — which is the single
most common way a PWA gets stuck on a version from last month. Under Shape A
advanced mode bypasses `_headers`, so `_worker.js` applies the same rules
itself.

---

## The mistake this document exists to prevent

`http://localhost:8787` is the address the proxy has while you are developing,
and it is the app's fallback. It is **not** an address a published site can
use: to every visitor's browser, "localhost" means their own computer. A
deployed app pointed at it fails on every request — and fails the same way for
you, on the same laptop running the proxy, because a page served over https
may not reach a plain-http address.

Until the proxy is reachable on the public internet over https, the app falls
back to the built-in tutor and says why under each answer. Nothing else breaks.

---

## If something looks wrong

| What you see | What it usually is |
|---|---|
| The old version, and a hard refresh does not help | The old service worker. DevTools → Application → Service Workers → **Unregister**, then reload. On a phone: close every tab of the site and reopen. |
| The build number at the foot of Settings is not the one you deployed | Same thing — the old service worker is still serving. Unregister it. |
| The install page loads, `/vocab/` gives a 404 | The zip was uploaded with a wrapper folder, so the site is one level down. Re-upload the archive as given; its root is the site root. |
| Ask and the coach say the proxy is unreachable | Read the sentence after the engine's name — it says which of the four causes it is. Then check `ALLOWED_ORIGIN` matches the browser bar exactly, including `https://` and no trailing slash. |
| Answers arrive signed "Built-in tutor" | The live engine could not be reached, so the app answered from the shipped dictionary. The reason is on the same line. |
| Sign up and Log in are not offered | `"accounts": false` — the database is not bound, or is bound under the wrong variable name. Part 5. |
| Everything worked, then Gemini stopped answering around the same time each day | The free daily quota. Add more keys, from separate Google accounts. Part 4. |
| "Install" does nothing on Android | The install prompt needs HTTPS and a valid manifest. Wait for the certificate to finish issuing. |

---

## Rotating a key

Keys leak — into screenshots, into chat logs, into a commit. Rotating one is
two minutes and costs nothing:

1. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → delete
   the old key, **Create API key**.
2. Paste the new one over the old value in Variables and Secrets.
3. Deploy, and reload `/api/health` — `keys` should be unchanged.

Nothing in the app or the archive needs rebuilding. The key lives in the
dashboard, never in the browser, and never in a file you hand to anyone.
