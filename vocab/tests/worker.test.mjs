/**
 * The Cloudflare Worker build of the proxy.
 *
 * It shares its prompts, schemas and Gemini client with the Node proxy, so
 * what needs guarding is the seam: the routes, the CORS headers, the SSE
 * envelope, and — the one that fails at deploy rather than at review — that
 * nothing it pulls in reaches for a Node builtin a Worker does not have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../server/worker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYED = { GEMINI_API_KEY: 'test-key', ALLOWED_ORIGIN: 'https://vocabx.example' };

const call = (method, pathname, body, env = KEYED) => worker.fetch(
  new Request(`https://proxy.example${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);

/* ── what a Worker can and cannot have ──────────────────────────────────── */

test('the Worker reaches for no Node builtin', () => {
  // Its imports are shared with the Node proxy, where node: is the norm; one
  // of them creeping in here is a deploy failure, not a test failure.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(!spec.startsWith('node:'),
        `${path.relative(ROOT, file)} imports ${spec}, which a Worker does not have`);
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
    }
  };
  walk(path.join(ROOT, 'server', 'worker.mjs'));
  assert.ok(seen.size >= 3, `expected the worker and its imports, walked ${seen.size}`);
});

test('the Gemini client works without process.env, which a Worker lacks', async () => {
  const { configure, geminiDefaultModel } = await import('../server/gemini.mjs');
  configure({ apiKey: 'from-a-binding', model: 'gemini-3.5-flash' });
  assert.equal(geminiDefaultModel(), 'gemini-3.5-flash');
  configure({});   // and back, so the other tests see the default
  assert.equal(geminiDefaultModel(), 'gemini-flash-lite-latest');
});

/* ── the routes ─────────────────────────────────────────────────────────── */

test('health reports each engine separately', async () => {
  const body = await (await call('GET', '/api/health')).json();
  assert.equal(body.ok, true);
  assert.equal(body.providers.gemini.ready, true);
  assert.equal(body.providers.anthropic.ready, false, 'no Claude key was given');
  assert.equal(body.runtime, 'cloudflare-worker');
});

test('an engine with no key is refused in words, not in a stack trace', async () => {
  const res = await call('POST', '/api/ai/word', { provider: 'anthropic', term: 'x' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /ANTHROPIC_API_KEY/);
});

test('a request missing its subject is a 400', async () => {
  const res = await call('POST', '/api/ai/word', { provider: 'gemini' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /No term given/);
});

test('an unknown route is a 404 rather than a hang', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

/**
 * The root path is where Cloudflare's editor previews a Worker, and where a
 * person pastes the URL to see whether the deploy worked. A bare 404 there
 * reads as failure at exactly that moment.
 */
test('the root path reports the service rather than 404ing', async () => {
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, 'VocabX AI proxy');
  assert.equal(body.ready, true);
  assert.match(body.next, /api\/health/);
});

test('the root path says plainly when a key or the origin lock is missing', async () => {
  const bare = await (await call('GET', '/', undefined, {})).json();
  assert.equal(bare.ready, false);
  assert.match(bare.engines.gemini, /no GEMINI_API_KEY/);
  assert.match(bare.allowedOrigin, /NOT SET/,
    'an unlocked Worker spends your credit for anyone who finds it — say so');
});

/* ── CORS, which is the whole reason a separate origin works ────────────── */

test('a preflight is answered without touching an engine', async () => {
  const res = await call('OPTIONS', '/api/ai/ask');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://vocabx.example');
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
});

test('ALLOWED_ORIGIN is what it says, and * only when it is unset', async () => {
  const locked = await call('GET', '/api/health');
  assert.equal(locked.headers.get('access-control-allow-origin'), 'https://vocabx.example');

  // Unset is the scratch-deployment default, and lets anyone spend the credit.
  const open = await call('GET', '/api/health', undefined, { GEMINI_API_KEY: 'k' });
  assert.equal(open.headers.get('access-control-allow-origin'), '*');
});

test('every response carries the CORS headers, errors included', async () => {
  for (const res of [await call('GET', '/api/nope'),
                     await call('POST', '/api/ai/word', { provider: 'gemini' })]) {
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://vocabx.example',
      'a failure the browser cannot read is a failure with no message');
  }
});

/* ── the streaming envelope the app parses ──────────────────────────────── */

test('a stream failure arrives as an SSE error frame, not a dead connection', async () => {
  // No network here: the Gemini call fails, and the app must still be told.
  const res = await call('POST', '/api/ai/ask',
    { provider: 'gemini', question: 'hello', history: [], level: 'B1' });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const text = await res.text();
  const frames = text.split(/\n\n/).filter(Boolean)
    .map((f) => JSON.parse(f.replace(/^data: /, '')));
  assert.ok(frames.length >= 1, 'the stream said nothing at all');
  assert.ok(frames.some((f) => f.type === 'error' || f.type === 'text_delta'),
    `expected an error or a delta, got ${JSON.stringify(frames)}`);
  assert.equal(frames.at(-1).type === 'done' || frames.at(-1).type === 'error', true);
});

/* ── the Pages build: app and proxy on one origin ───────────────────────── */

/**
 * Pages "advanced mode" hands every request to the Worker and serves the
 * site through an ASSETS binding — which also means the `_headers` file is
 * never read. The rules it carries have to be reapplied here, and the first
 * of them is not cosmetic: without it a browser can pin a stale service
 * worker, which is how a PWA gets stuck on an old version for good.
 */
const pages = await import('../server/pages-worker.mjs').then((m) => m.default);

/** A stand-in ASSETS binding that answers everything. */
const ASSETS = { fetch: async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) };
const site = (pathname, env = { ASSETS, GEMINI_API_KEY: 'k' }) =>
  pages.fetch(new Request(`https://vocabx.example${pathname}`), env, {});

test('the site and the API answer on one origin', async () => {
  const page = await site('/vocab/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);

  const api = await site('/api/health');
  assert.equal((await api.json()).providers.gemini.ready, true,
    'the same deployment serves both, which is the whole point of this build');
});

test('the caching rules from _headers survive advanced mode', async () => {
  const cases = [
    ['/vocab/sw.js', 'no-cache'],
    ['/vocab/manifest.webmanifest', 'no-cache'],
    ['/vocab/fonts/space-grotesk.woff2', 'public, max-age=31536000, immutable'],
    ['/vocab/data/modules/index.json', 'public, max-age=3600'],
    ['/vocab/icons/mark-64.webp', 'public, max-age=604800'],
  ];
  for (const [pathname, expected] of cases) {
    assert.equal((await site(pathname)).headers.get('cache-control'), expected,
      `${pathname} lost its rule`);
  }
});

test('the security headers survive too', async () => {
  const res = await site('/vocab/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
});

test('a page with no rule of its own is left uncached rather than mis-cached', async () => {
  assert.equal((await site('/vocab/index.html')).headers.get('cache-control'), null);
});

test('the proxy is pinned to its own origin, whatever the environment says', async () => {
  // A copy of this file running elsewhere must not answer for this domain.
  const res = await site('/api/health', { ASSETS, GEMINI_API_KEY: 'k', ALLOWED_ORIGIN: 'https://somewhere.else' });
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://vocabx.example');
});
