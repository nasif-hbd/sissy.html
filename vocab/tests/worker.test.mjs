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
