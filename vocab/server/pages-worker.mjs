/**
 * The whole site — app and AI proxy — as one Cloudflare Pages deployment.
 *
 * Pages calls this "advanced mode": drop the built file in as `_worker.js` at
 * the output root and it handles every request, serving the static files
 * through the ASSETS binding. Which means the AI routes and the app share an
 * origin, and that removes the three things that go wrong when they do not:
 * no CORS, no ALLOWED_ORIGIN to keep in step with the domain, and no proxy
 * address to paste into Settings — it is left empty.
 *
 * It also needs no Workers dashboard and no CLI. It goes up the same way the
 * site already does: drag the folder into Pages.
 *
 *   ./build-worker.sh    → dist/_worker.js, to sit beside index.html
 */
import proxy from './worker.mjs';

/**
 * A key baked in at build time, for a deployment with nothing to configure.
 *
 * `build-worker.sh --key <k>` replaces this. It is a fallback, not an
 * override: a GEMINI_API_KEY set on the Pages project always wins, so the key
 * can be rotated in the dashboard without rebuilding.
 *
 * A Worker's source is never served to visitors — Cloudflare runs it rather
 * than sending it — so a key here does not reach the browser, which is the
 * line that actually matters. What it does do is put the key in a file: a
 * build with one in it must not go into a public repository, and Google
 * revokes keys it finds in one.
 */
const BAKED_KEY = '';

/*
 * Advanced mode bypasses the `_headers` file, so the rules that file carries
 * are applied here instead. Losing them silently would be worse than the
 * inconvenience: without the first rule a browser can pin a stale service
 * worker, which is how a PWA gets stuck on an old version for good.
 */
const CACHE_RULES = [
  [/^\/vocab\/sw\.js$/,              'no-cache'],
  [/^\/vocab\/manifest\.webmanifest$/, 'no-cache'],
  [/^\/vocab\/fonts\//,              'public, max-age=31536000, immutable'],
  [/^\/vocab\/data\//,               'public, max-age=3600'],
  [/^\/vocab\/icons\//,              'public, max-age=604800'],
  [/^\/download\//,                  'public, max-age=3600'],
];

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=()',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The proxy's own routes. Everything else is the app.
    if (url.pathname.startsWith('/api/')) {
      /* Same origin, so a browser sends no Origin header and asks no
         preflight — but the Worker still reads ALLOWED_ORIGIN, and unset
         means "*". Pin it to this deployment so that a copy of this file
         running somewhere else cannot be pointed at from anywhere. */
      const settings = { ...env };
      // Only where the deployment has none of its own, so a key set on the
      // project overrides the baked one rather than being shadowed by it.
      if (!settings.GEMINI_API_KEY && BAKED_KEY) settings.GEMINI_API_KEY = BAKED_KEY;
      // Last, so nothing above can loosen the origin lock.
      settings.ALLOWED_ORIGIN = url.origin;
      return proxy.fetch(request, settings);
    }

    /* Pages keeps _worker.js out of the static assets, so this should never
       fire — which is exactly why it is here. A key can be baked into this
       file, and one misconfiguration away from being served is too close. */
    if (/^\/_worker\.js$/i.test(url.pathname)) {
      return Response.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }

    const asset = await env.ASSETS.fetch(request);
    const res = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(SECURITY)) res.headers.set(key, value);
    const rule = CACHE_RULES.find(([pattern]) => pattern.test(url.pathname));
    if (rule) res.headers.set('cache-control', rule[1]);
    return res;
  },
};
