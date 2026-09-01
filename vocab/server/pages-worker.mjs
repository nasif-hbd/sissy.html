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
      // ...env first, then the pin: spread last wins, and the pin must.
      return proxy.fetch(request, { ...env, ALLOWED_ORIGIN: url.origin });
    }

    const asset = await env.ASSETS.fetch(request);
    const res = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(SECURITY)) res.headers.set(key, value);
    const rule = CACHE_RULES.find(([pattern]) => pattern.test(url.pathname));
    if (rule) res.headers.set('cache-control', rule[1]);
    return res;
  },
};
