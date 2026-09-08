/**
 * Accounts: the password path, and the line between a guest and a signed-in
 * learner.
 *
 * Run against real SQL rather than a stub. The interesting failures here are
 * SQL ones — a UNIQUE index that does not actually reject a second signup, an
 * ON CONFLICT clause that resets a counter it should have incremented — and a
 * hand-written fake would agree with whatever the code did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  accountsOf, cleanEmail, cleanName, isVerifier, isToken, newToken, sha256,
  lockUp, matches, MAX_TRIES,
} from '../server/accounts.mjs';
import { whoIs } from '../server/worker.mjs';

/** D1's shape over an in-memory SQLite. Enough of it for this module. */
function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

const env = () => ({ DB: d1() });
/* What the browser sends: 32 bytes of PBKDF2 output, hex. Never a password. */
const verifier = (seed) => seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a');

// ── what an account may be called ──────────────────────────────────────────

test('an email is normalised before it is anything else', () => {
  assert.equal(cleanEmail('  Reader@Example.COM '), 'reader@example.com');
  // Otherwise Reader@ and reader@ are two accounts and one of them is a trap.
  assert.equal(cleanEmail('reader@example.com'), cleanEmail('READER@EXAMPLE.COM'));
});

test('an address that could not be one is refused', () => {
  for (const bad of ['', 'reader', 'reader@', '@example.com', 'a@b', 'two @spaces.com', 'x'.repeat(200)]) {
    assert.equal(cleanEmail(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('only the browser’s stretched output counts as a verifier', () => {
  assert.equal(isVerifier('a'.repeat(64)), true);
  // A client that sent the password itself must be refused, not hashed as-is.
  assert.equal(isVerifier('correct horse battery staple'), false);
  assert.equal(isVerifier('a'.repeat(63)), false);
  assert.equal(isVerifier('A'.repeat(64)), false, 'uppercase hex is not what we emit');
});

test('a missing name becomes something a header can show', () => {
  assert.equal(cleanName('', 'jane.doe@example.com'), 'Jane doe');
  assert.equal(cleanName('  Nasif  Ahmed ', 'x@y.com'), 'Nasif Ahmed');
});

// ── the password path ──────────────────────────────────────────────────────

test('a verifier matches only itself', async () => {
  const stored = await lockUp(verifier('abc'));
  assert.equal(await matches(verifier('abc'), stored), true);
  assert.equal(await matches(verifier('abd'), stored), false);
});

test('the same password twice gives two different stored values', async () => {
  // Without a per-account salt, one cracked hash cracks everyone who chose it.
  const a = await lockUp(verifier('same'));
  const b = await lockUp(verifier('same'));
  assert.notEqual(a, b);
  assert.equal(await matches(verifier('same'), a), true);
  assert.equal(await matches(verifier('same'), b), true);
});

test('a corrupt stored value fails closed', async () => {
  for (const junk of ['', 'nonsense', '$', 'salt$', null, undefined]) {
    assert.equal(await matches(verifier('abc'), junk), false, `let through: ${junk}`);
  }
});

// ── sessions ───────────────────────────────────────────────────────────────

test('a session token is never written down', async () => {
  const e = env();
  const users = accountsOf(e);
  const made = await users.create({ email: 'a@b.com', name: 'A', verifier: verifier('pw') });
  const token = await users.open(made.id);

  assert.equal(isToken(token), true);
  const rows = e.DB.raw.prepare('SELECT token FROM sessions').all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token, token, 'the token itself is in the database');
  assert.equal(rows[0].token, await sha256(token), 'stored as anything but its hash');
});

test('two tokens are never the same', async () => {
  const seen = new Set(Array.from({ length: 200 }, () => newToken()));
  assert.equal(seen.size, 200);
});

test('signing out ends one device; everywhere ends them all', async () => {
  const users = accountsOf(env());
  const made = await users.create({ email: 'a@b.com', name: 'A', verifier: verifier('pw') });
  const phone = await users.open(made.id);
  const laptop = await users.open(made.id);

  await users.close(phone);
  assert.equal(await users.whose(phone), null);
  assert.equal((await users.whose(laptop))?.id, made.id, 'the other device was signed out too');

  await users.closeAll(made.id);
  assert.equal(await users.whose(laptop), null);
});

test('a token nobody minted is nobody', async () => {
  const users = accountsOf(env());
  await users.create({ email: 'a@b.com', name: 'A', verifier: verifier('pw') });
  assert.equal(await users.whose(newToken()), null);
});

// ── signing up and in ──────────────────────────────────────────────────────

test('an email cannot be claimed twice', async () => {
  const users = accountsOf(env());
  assert.ok(await users.create({ email: 'a@b.com', name: 'First', verifier: verifier('pw') }));
  // The unique index is what decides this, which is also the only way to ask
  // that two simultaneous signups cannot both win.
  assert.equal(await users.create({ email: 'a@b.com', name: 'Second', verifier: verifier('other') }), null);
});

test('wrong attempts lock the account, and the right one clears the count', async () => {
  const users = accountsOf(env());
  await users.create({ email: 'a@b.com', name: 'A', verifier: verifier('pw') });

  assert.equal(await users.lockedFor('a@b.com'), null);
  for (let i = 0; i < MAX_TRIES - 1; i += 1) await users.noteFailure('a@b.com');
  assert.equal(await users.lockedFor('a@b.com'), null, 'locked one try early');

  await users.noteFailure('a@b.com');
  assert.ok(await users.lockedFor('a@b.com'), 'never locked');

  await users.clearFailures('a@b.com');
  assert.equal(await users.lockedFor('a@b.com'), null, 'a good password did not clear the count');
});

test('erasing an account takes the sessions with it', async () => {
  const users = accountsOf(env());
  const made = await users.create({ email: 'a@b.com', name: 'A', verifier: verifier('pw') });
  const token = await users.open(made.id);

  await users.erase(made.id);
  assert.equal(await users.byId(made.id), null);
  assert.equal(await users.whose(token), null, 'the session outlived the account');
});

// ── the boundary ───────────────────────────────────────────────────────────
// whoIs decides whose progress a sync request may touch. Everything else in
// the sync path trusts what it returns, so these are the tests that matter.

const DEVICE = 'abcdefghijklmnop1234';

test('a token names its own account and nobody else’s', async () => {
  const e = env();
  const users = accountsOf(e);
  const mine = await users.create({ email: 'me@b.com', name: 'Me', verifier: verifier('pw') });
  const yours = await users.create({ email: 'you@b.com', name: 'You', verifier: verifier('pw2') });
  const token = await users.open(mine.id);

  assert.equal((await whoIs({ token }, e))?.uid, mine.id);

  /* The one that would be quiet and total: a caller who sends their own token
     and someone else's uid must not be handed the other account. */
  const sneaky = await whoIs({ token, uid: yours.id }, e);
  assert.equal(sneaky?.uid, mine.id, 'a uid in the body overrode the session');
});

test('an unusable token is refused, not quietly demoted to a device id', async () => {
  const e = env();
  // Otherwise an expired session silently becomes a guest read of any id the
  // caller cares to name — which is the whole boundary, gone.
  assert.equal(await whoIs({ token: newToken(), uid: DEVICE }, e), null);
  assert.equal(await whoIs({ token: 'not-a-token', uid: DEVICE }, e), null);
  assert.equal((await whoIs({ token: '', uid: DEVICE }, e))?.uid, DEVICE, 'no token at all is guest mode');
});

test('a guest is still a guest', async () => {
  const e = env();
  const who = await whoIs({ uid: DEVICE }, e);
  assert.equal(who.uid, DEVICE);
  assert.equal(who.account, null);
  assert.equal(await whoIs({ uid: 'short' }, e), null);
});

test('accounts need D1, and say so rather than half working', () => {
  // KV has no unique index, so it cannot promise one address is one account.
  assert.equal(accountsOf({ STORE: { get() {}, put() {} } }), null);
  assert.equal(accountsOf({}), null);
});
