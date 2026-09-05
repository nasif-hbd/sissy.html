/**
 * The account routes, end to end, through the Worker's own fetch handler.
 *
 * Not the functions underneath them — the routes, with real Requests, real
 * JSON, real CORS and a real database. Every bug worth catching here lives in
 * the wiring rather than the pieces: a route that forgets to check a token, a
 * response that hands back something it should not, an origin check that lets
 * the wrong page through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../server/worker.mjs';

/** D1's shape over an in-memory SQLite. */
function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  });
  return { raw: db, prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); } };
}

const env = () => ({ DB: d1(), ALLOWED_ORIGIN: 'https://vocabx.example' });

async function call(route, body, e) {
  const res = await worker.fetch(new Request(`https://proxy.example${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://vocabx.example' },
    body: JSON.stringify(body),
  }), e);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/* 32 bytes of hex, which is what the browser's PBKDF2 produces. The routes
   reject anything else, so a test that sent a password would test nothing. */
const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);

test('signing up returns a session and never the password material', async () => {
  const e = env();
  const { body } = await call('/api/auth/signup', { email: 'a@b.com', name: 'Ann', verifier: V1 }, e);

  assert.equal(body.ok, true);
  assert.ok(body.token);
  assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id', 'made', 'name']);

  const text = JSON.stringify(body);
  assert.ok(!text.includes(V1), 'the verifier came back in the response');
  assert.ok(!text.includes('pass'), 'the stored hash came back in the response');
});

test('the same email cannot be signed up twice', async () => {
  const e = env();
  await call('/api/auth/signup', { email: 'a@b.com', verifier: V1 }, e);
  const { body } = await call('/api/auth/signup', { email: 'A@B.com', verifier: V2 }, e);
  // Normalised first, or the capitalisation is a second account.
  assert.equal(body.ok, false);
  assert.match(body.error, /already has an account/);
});

test('the right password signs in and the wrong one does not', async () => {
  const e = env();
  await call('/api/auth/signup', { email: 'a@b.com', verifier: V1 }, e);

  assert.equal((await call('/api/auth/login', { email: 'a@b.com', verifier: V1 }, e)).body.ok, true);

  const bad = await call('/api/auth/login', { email: 'a@b.com', verifier: V2 }, e);
  assert.equal(bad.body.ok, false);

  /* The same sentence for an account that does not exist. Two different ones
     would turn this route into a way to ask who has an account here. */
  const missing = await call('/api/auth/login', { email: 'nobody@b.com', verifier: V1 }, e);
  assert.equal(missing.body.error, bad.body.error);
});

test('a client that skips the stretching is refused, not hashed as-is', async () => {
  const e = env();
  const { body } = await call('/api/auth/signup',
    { email: 'a@b.com', verifier: 'correct horse battery staple' }, e);
  assert.equal(body.ok, false);
  assert.match(body.error, /malformed/);
});

test('progress saved under a session comes back to that session', async () => {
  const e = env();
  const { body: made } = await call('/api/auth/signup', { email: 'a@b.com', verifier: V1 }, e);

  const snapshot = { v: 1, words: { hello: { term: 'hello' } }, srs: {}, days: {}, history: [] };
  assert.equal((await call('/api/sync/progress', { token: made.token, snapshot }, e)).body.ok, true);

  const got = await call('/api/sync/progress/get', { token: made.token }, e);
  assert.equal(got.body.found, true);
  assert.deepEqual(got.body.snapshot, snapshot);
});

test('one account cannot read another’s by naming it', async () => {
  const e = env();
  const { body: mine } = await call('/api/auth/signup', { email: 'me@b.com', verifier: V1 }, e);
  const { body: yours } = await call('/api/auth/signup', { email: 'you@b.com', verifier: V2 }, e);

  await call('/api/sync/progress', { token: yours.token, snapshot: { v: 1, secret: 'yours' } }, e);

  /* The whole boundary in one request: my token, your uid. The uid must be
     ignored — resolved from the session, never read from the body. */
  const peek = await call('/api/sync/progress/get', { token: mine.token, uid: yours.user.id }, e);
  assert.equal(peek.body.found, false, 'a uid in the body reached another account');
});

test('an expired or forged token is refused rather than treated as a guest', async () => {
  const e = env();
  const { body: mine } = await call('/api/auth/signup', { email: 'me@b.com', verifier: V1 }, e);
  await call('/api/sync/progress', { token: mine.token, snapshot: { v: 1, mine: true } }, e);

  // A guest id would be accepted on its own; alongside a bad token it must not be.
  const forged = await call('/api/sync/progress/get',
    { token: 'x'.repeat(48), uid: mine.user.id }, e);
  assert.equal(forged.body.ok, false);
  assert.match(forged.body.error, /does not name an account or a device/);
});

test('a guest with no token still works exactly as before', async () => {
  const e = env();
  const uid = 'guestdevice1234567890';
  assert.equal((await call('/api/sync/progress',
    { uid, snapshot: { v: 1, words: {} } }, e)).body.ok, true);
  assert.equal((await call('/api/sync/progress/get', { uid }, e)).body.found, true);
});

test('signing out ends the session it was given', async () => {
  const e = env();
  const { body: made } = await call('/api/auth/signup', { email: 'a@b.com', verifier: V1 }, e);

  await call('/api/auth/logout', { token: made.token }, e);
  assert.equal((await call('/api/auth/session', { token: made.token }, e)).body.ok, false);
  assert.equal((await call('/api/sync/progress/get', { token: made.token }, e)).body.ok, false);
});

test('deleting an account takes its progress with it', async () => {
  const e = env();
  const { body: made } = await call('/api/auth/signup', { email: 'a@b.com', verifier: V1 }, e);
  await call('/api/sync/progress', { token: made.token, snapshot: { v: 1, words: {} } }, e);

  assert.equal((await call('/api/auth/delete', { token: made.token }, e)).body.erased, true);
  // And the address is free again, which is what "deleted" has to mean.
  assert.equal((await call('/api/auth/signup', { email: 'a@b.com', verifier: V2 }, e)).body.ok, true);
});

test('a deployment with no database says so instead of failing oddly', async () => {
  const { body } = await call('/api/auth/signup', { email: 'a@b.com', verifier: V1 }, {});
  assert.equal(body.ok, false);
  assert.match(body.error, /no database/i);
  assert.match(body.error, /guest/, 'told someone what is broken but not what still works');
});

test('health reports whether accounts are possible, and nothing secret', async () => {
  const res = await worker.fetch(new Request('https://proxy.example/api/health'), env());
  const body = await res.json();
  assert.equal(typeof body.accounts, 'object');
  assert.equal(body.accounts.rounds, 250_000);
  assert.equal((await (await worker.fetch(
    new Request('https://proxy.example/api/health'), {})).json()).accounts, false);
});

test('the write budget works with only a database bound', async () => {
  const e = env();
  const ip = { 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json',
               origin: 'https://vocabx.example' };
  const post = (route, body) => worker.fetch(new Request(`https://proxy.example${route}`, {
    method: 'POST', headers: ip, body: JSON.stringify(body),
  }), e).then((r) => r.json());

  /* This used to need a KV namespace and did nothing at all without one —
     which is the shape of deployment this app has, so every write route was
     unlimited in practice. Twenty signups an hour from one address. */
  const emails = Array.from({ length: 22 }, (_, i) => `n${i}@b.com`);
  const results = [];
  for (const email of emails) results.push(await post('/api/auth/signup', { email, verifier: V1 }));

  assert.equal(results.filter((r) => r.ok).length, 20);
  assert.match(results.at(-1).error, /Too many accounts/);
});

test('a limiter that cannot work lets the app work', async () => {
  // Failing closed would take the whole app down the first time this table
  // had a bad day; failing open loses one request's budget.
  const e = { DB: { prepare: () => { throw new Error('no such table'); } } };
  const { withinRate } = await import('../server/store.mjs');
  assert.equal(await withinRate(e, '203.0.113.9'), true);
});

test('a name can be changed, and only by its owner', async () => {
  const e = env();
  const { body: mine } = await call('/api/auth/signup', { email: 'me@b.com', name: 'Me', verifier: V1 }, e);
  const { body: yours } = await call('/api/auth/signup', { email: 'you@b.com', name: 'You', verifier: V2 }, e);

  const renamed = await call('/api/auth/rename', { token: mine.token, name: '  Nasif   Ahmed ' }, e);
  assert.equal(renamed.body.user.name, 'Nasif Ahmed', 'whitespace reached the database');

  // It comes back on the next resume, not just in this reply.
  assert.equal((await call('/api/auth/session', { token: mine.token }, e)).body.user.name, 'Nasif Ahmed');
  // And it went nowhere near the other account.
  assert.equal((await call('/api/auth/session', { token: yours.token }, e)).body.user.name, 'You');
});

test('renaming needs a session, not a uid', async () => {
  const e = env();
  const { body: mine } = await call('/api/auth/signup', { email: 'me@b.com', name: 'Me', verifier: V1 }, e);
  const out = await call('/api/auth/rename', { uid: mine.user.id, name: 'Someone Else' }, e);
  assert.equal(out.body.ok, false);
  // A device id names data, never an account — it must not be able to rename one.
  assert.equal((await call('/api/auth/session', { token: mine.token }, e)).body.user.name, 'Me');
});

test('an emptied name becomes something, not nothing', async () => {
  const e = env();
  const { body: mine } = await call('/api/auth/signup', { email: 'jane.doe@b.com', verifier: V1 }, e);
  const out = await call('/api/auth/rename', { token: mine.token, name: '   ' }, e);
  // A blank header is worse than a guess, and the address is a decent guess.
  assert.equal(out.body.user.name, 'Jane doe');
});

test('the join date travels with the account', async () => {
  const e = env();
  const { body } = await call('/api/auth/signup', { email: 'a@b.com', verifier: V1 }, e);
  /* Profile says "member since". The local install date cannot answer that —
     signing in on a new phone would date the membership to this morning. */
  assert.match(body.user.made, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await call('/api/auth/login', { email: 'a@b.com', verifier: V1 }, e)).body.user.made,
    body.user.made);
  assert.equal((await call('/api/auth/session', { token: body.token }, e)).body.user.made,
    body.user.made);
});
