# Publishing VocabX on Cloudflare Pages

The app is static — HTML, CSS, ES modules and JSON. There is nothing to build,
so Cloudflare serves the repository as it stands.

Two things are worth knowing before you start:

- **The app itself needs no server.** The 117,845-word dictionary, all fourteen
  packs, the grammar bank, spaced repetition, the Test tab and offline support
  are files. Pages serves files.
- **The AI features need one.** Ask, the writing coach, the weekly summary and
  emailed feedback go through `vocab/server/proxy.mjs`, which holds your API
  key. Pages does not run it. Part 4 covers where to put it, and the app works
  without it — the built-in tutor answers from the shipped dictionary.

---

## Part 1 — Put the domain on Cloudflare

Skip this if `ylarena.online` is already in your Cloudflare account.

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a
   domain** → type `ylarena.online` → **Continue**.
2. Choose the **Free** plan.
3. Cloudflare scans your existing DNS records. Check the list against whatever
   the domain does today — **if email is set up on this domain, make sure the
   MX and TXT records came across**, because a missing MX record is how a
   domain move quietly stops mail.
4. Cloudflare shows you **two nameservers**, something like
   `ana.ns.cloudflare.com` and `bob.ns.cloudflare.com`.
5. Sign in wherever you bought `ylarena.online`, find **Nameservers** (often
   under DNS or Domain settings), and replace what is there with those two.
6. Back in Cloudflare, press **Check nameservers**. It usually takes a few
   minutes to a few hours. You get an email when the domain is active.

You cannot attach a custom domain to Pages until this shows **Active**.

---

## Part 2 — Create the Pages project

1. In the Cloudflare dashboard: **Compute (Workers & Pages)** → **Create** →
   **Pages** tab → **Connect to Git**.
2. Authorise GitHub if you have not already, and pick **`nasif-hbd/sissy.html`**.
   If the repository is not listed, use **Configure GitHub App** and grant
   access to it.
3. Set up the build. This is the part people get wrong, so take it literally:

   | Field | Value |
   |---|---|
   | Project name | `vocabx` |
   | Production branch | `main` |
   | Framework preset | **None** |
   | Build command | *leave empty* |
   | Build output directory | `/` |

   There is no build step. If you put anything in the build command it will run
   and fail.

4. **Save and Deploy.** The first deploy takes a minute or two.
5. You get a URL like `vocabx.pages.dev`. Open it — the install page should
   appear, and `vocabx.pages.dev/vocab/` should open the app. **Check this
   works before adding the domain**, so that if something is wrong you know it
   is the deploy and not the DNS.

---

## Part 3 — Attach ylarena.online

1. Open the project → **Custom domains** → **Set up a custom domain**.
2. Enter `ylarena.online` → **Continue** → **Activate domain**.
   Because the domain is already on Cloudflare, the DNS record is created for
   you. Nothing to copy or paste.
3. Repeat for **`www.ylarena.online`** if you want it to work too. Cloudflare
   redirects one to the other automatically.
4. Wait for the status to go from *Initializing* to **Active** — usually a
   minute or two, occasionally up to fifteen while the certificate is issued.

Then:

- `https://ylarena.online/` — the install page
- `https://ylarena.online/vocab/` — the app

HTTPS is automatic and free. Nothing else to configure.

### Send people straight to the app (optional)

If you would rather the bare domain open the app instead of the install page,
add a file called `_redirects` at the root of the repository:

```
/    /vocab/    302
```

Do this only if you are sure — the install page is what tells someone on a
phone how to add VocabX to their home screen, and a redirect skips it.

---

## Part 4 — The AI proxy, if you want the AI features

Pages serves files; it does not run Node. `vocab/server/proxy.mjs` needs a
host that does — Render, Railway, Fly.io or a small VPS all work, and the
first three have a free tier.

There are three shapes. The first needs no other account and no repository
connection, which is why it is first.

### A — A Cloudflare Worker (recommended if the app is already on Pages)

`vocab/server/worker.mjs` is the same proxy, built for Workers: the same
prompts, the same schemas, the same Gemini client as the Node proxy, sharing
the files rather than copying them. Workers have no Node, so it drops the
three things that need one — serving the app's files, web push, and emailed
feedback over SMTP. The seven AI routes and translation are all there.

Free tier, no cold start, and it lives in the dashboard you already have.

**With no CLI and no connected repository:**

1. Run `vocab/server/build-worker.sh` — it writes `dist/worker.js`, one file.
2. Cloudflare dashboard → **Workers & Pages → Create → Start with Hello
   World → Deploy**, then **Edit code**, and paste `dist/worker.js` over
   what is there. Deploy.
3. **Settings → Variables and Secrets** on the Worker:
   - Secret **`GEMINI_API_KEY`** — your key.
   - Variable **`ALLOWED_ORIGIN`** — `https://vocabx.ylarena.online`, no path,
     no trailing slash. Without it the Worker answers anyone, and anyone who
     finds the URL can spend your API credit.
4. In the app: **Settings → AI help → Gemini → Your server** = the Worker's
   URL (`https://vocabx-proxy.<you>.workers.dev`).

**With the CLI**, from `vocab/server`: `npx wrangler secret put GEMINI_API_KEY`
then `npx wrangler deploy`. `wrangler.toml` is already there.

### B — One host serves both

`proxy.mjs` already serves the app beside its own API — the whole of `vocab/`
is on the same origin as `/api/...`. Deploy the repo to a Node host, point
your domain at it, and:

1. Set `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`).
2. In the app: **Settings → AI help → Your server** — **leave it empty**.

That is the whole configuration. No CORS, no `ALLOWED_ORIGIN`, no second
address to keep in step, and no way to point at the wrong one. You can drop
Cloudflare Pages entirely, or keep it in front as a CDN.

### C — Pages serves the app, a Node proxy lives elsewhere

Keep the Pages deployment from Parts 1–3 and host only the proxy. Then:

1. Set the environment variables from `vocab/server/.env.example`. At minimum
   `ANTHROPIC_API_KEY` (or `GEMINI_API_KEY`).
2. Set **`ALLOWED_ORIGIN=https://ylarena.online`** — no path, no trailing
   slash. Without it the proxy answers requests from anywhere, and anyone can
   spend your API credit.
3. In the app: **Settings → AI help → Your server**, and enter the **https**
   address the proxy is reachable at.

The API key stays on the proxy and never reaches the browser. That is the
entire reason the proxy exists.

### The mistake this part exists to prevent

`http://localhost:8787` is the address the proxy has while you are developing,
and it is the app's default. It is **not** an address a published site can
use: to every visitor's browser, "localhost" means their own computer, not
yours. A deployed app pointed at it fails on every request — and it fails the
same way for you, on the same laptop that is running the proxy, because a page
served over https is not allowed to reach a plain-http address.

So the proxy has to be reachable on the public internet, over https, before
the AI engines will answer for anybody. Until it is, the app falls back to the
built-in tutor and says why under each answer; nothing else breaks.

---

## Afterwards

**Every push to `main` deploys.** Cloudflare watches the branch; there is
nothing to run. A deploy takes about a minute, and the dashboard keeps every
previous one, so **Rollback** on an earlier deploy undoes a bad release
immediately.

**`_headers` is already in the repository** and Cloudflare applies it. It caches
the typeface for a year, the word packs for an hour — they keep their filenames
when rebuilt, so caching them forever would strand people on old data — and
tells browsers never to cache `sw.js`, which is the single most common way a
PWA gets stuck on a version from last month.

**Leave GitHub Pages alone or turn it off**, whichever you prefer. Both can
serve the same repository at once; the canonical link now points at
`ylarena.online`, so search engines will treat that as the real address.

### If something looks wrong

| What you see | What it usually is |
|---|---|
| The old version, and a hard refresh does not help | The old service worker. Open DevTools → Application → Service Workers → **Unregister**, then reload. |
| The install page loads, `/vocab/` gives a 404 | Build output directory is not `/`. Settings → Builds & deployments. |
| "Install" does nothing on Android | The install prompt needs HTTPS and a valid manifest. Wait for the certificate to finish issuing. |
| Ask and the coach say the proxy is unreachable | Read the sentence after the engine's name — it says which of the four causes it is. Then Part 4, and check `ALLOWED_ORIGIN` matches the address in the browser bar exactly. |
| Answers arrive but are signed "Built-in tutor" | The live engine could not be reached, so the app answered from the dictionary instead. The reason is on the same line. |
