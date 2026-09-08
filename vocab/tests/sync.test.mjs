/**
 * Keeping a learner's work on a server.
 *
 * The design decision worth testing is the one that was asked for and turned
 * down: keying the data by the caller's IP address. It fails in both
 * directions at once, and both are invisible until real people are using it.
 * Everyone behind a carrier's NAT shares one address, so their work would be
 * merged; and one person's address changes when they move cell or rejoin
 * wifi, so their work would be lost. These pin the id-based key instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { storeOf, withinRate, ID, LIMITS } from '../server/store.mjs';

/** A D1 stand-in: enough SQL awareness to prove the adapter's shape. */
function fakeD1() {
  const rows = { progress: new Map(), chats: [] };
  let seq = 0;
  const run = (sql, args) => {
    if (/^CREATE/i.test(sql)) return { success: true };
    if (/^INSERT INTO progress/i.test(sql)) {
      rows.progress.set(args[0], { at: args[1], snapshot: args[2] });
      return { success: true };
    }
    if (/^INSERT INTO chats/i.test(sql)) {
      rows.chats.push({ id: ++seq, uid: args[0], at: args[1],
                        question: args[2], answer: args[3], engine: args[4] });
      return { success: true };
    }
    if (/^DELETE FROM chats WHERE uid = \? AND id NOT IN/i.test(sql)) {
      const [uid, , limit] = args;
      const keep = new Set(rows.chats.filter((c) => c.uid === uid)
        .sort((a, b) => b.id - a.id).slice(0, limit).map((c) => c.id));
      rows.chats = rows.chats.filter((c) => c.uid !== uid || keep.has(c.id));
      return { success: true };
    }
    if (/^DELETE FROM progress/i.test(sql)) { rows.progress.delete(args[0]); return {}; }
    if (/^DELETE FROM chats WHERE uid = \?$/i.test(sql)) {
      rows.chats = rows.chats.filter((c) => c.uid !== args[0]);
      return {};
    }
    return { success: true };
  };

  const stmt = (sql) => ({
    _args: [],
    bind(...args) { this._args = args; return this; },
    run() { return Promise.resolve(run(sql, this._args)); },
    first() {
      if (/FROM progress/i.test(sql)) return Promise.resolve(rows.progress.get(this._args[0]) || null);
      return Promise.resolve(null);
    },
    all() {
      if (/FROM chats/i.test(sql)) {
        const [uid, limit] = this._args;
        return Promise.resolve({ results: rows.chats.filter((c) => c.uid === uid)
          .sort((a, b) => b.id - a.id).slice(0, limit) });
      }
      return Promise.resolve({ results: [] });
    },
  });

  return { prepare: stmt, batch: (list) => Promise.all(list.map((x) => x.run())), _rows: rows };
}

/** A KV stand-in. */
function fakeKV() {
  const map = new Map();
  return {
    put: async (k, v) => { map.set(k, v); },
    get: async (k) => map.get(k) ?? null,
    delete: async (k) => { map.delete(k); },
    _map: map,
  };
}

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

test('two learners never see each other, which an IP key could not promise', async () => {
  // The whole reason the key is a device id. On a shared carrier address these
  // two would have been one row.
  for (const make of [fakeD1, fakeKV]) {
    const store = storeOf({ DB: make() });
    await store.saveProgress(A, { words: { w1: 1 } }, '2026-01-01T00:00:00Z');
    await store.saveProgress(B, { words: { w2: 2 } }, '2026-01-01T00:00:00Z');
    await store.addChat(A, { at: '2026-01-01T00:00:00Z', question: 'mine', answer: 'a' });
    await store.addChat(B, { at: '2026-01-01T00:00:00Z', question: 'theirs', answer: 'b' });

    assert.deepEqual((await store.loadProgress(A)).snapshot, { words: { w1: 1 } }, store.kind);
    assert.deepEqual((await store.loadProgress(B)).snapshot, { words: { w2: 2 } }, store.kind);
    assert.deepEqual((await store.listChats(A)).map((c) => c.question), ['mine'], store.kind);
    assert.deepEqual((await store.listChats(B)).map((c) => c.question), ['theirs'], store.kind);
  }
});

test('saving twice updates rather than duplicating', async () => {
  for (const make of [fakeD1, fakeKV]) {
    const store = storeOf({ DB: make() });
    await store.saveProgress(A, { n: 1 }, '2026-01-01T00:00:00Z');
    await store.saveProgress(A, { n: 2 }, '2026-01-02T00:00:00Z');
    const got = await store.loadProgress(A);
    assert.deepEqual(got.snapshot, { n: 2 });
    assert.equal(got.at, '2026-01-02T00:00:00Z');
  }
});

test('chats come back newest first and stop growing', async () => {
  for (const make of [fakeD1, fakeKV]) {
    const store = storeOf({ DB: make() });
    for (let i = 0; i < LIMITS.chats + 25; i++) {
      await store.addChat(A, { at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
        question: `q${i}`, answer: `a${i}` });
    }
    const rows = await store.listChats(A, 500);
    assert.equal(rows.length, LIMITS.chats, `${store.kind} kept ${rows.length}`);
    assert.equal(rows[0].question, `q${LIMITS.chats + 24}`, `${store.kind} is not newest-first`);
  }
});

test('forgetting takes everything, and only that learner\u2019s', async () => {
  for (const make of [fakeD1, fakeKV]) {
    const store = storeOf({ DB: make() });
    await store.saveProgress(A, { n: 1 }, 'now');
    await store.addChat(A, { at: 'now', question: 'q', answer: 'a' });
    await store.saveProgress(B, { n: 2 }, 'now');

    await store.forget(A);
    assert.equal(await store.loadProgress(A), null);
    assert.deepEqual(await store.listChats(A), []);
    // The neighbour is untouched — a delete that took the whole table would
    // pass every check above.
    assert.ok(await store.loadProgress(B), `${store.kind} deleted somebody else's work`);
  }
});

test('a bad id never reaches a query', () => {
  // The routes check this before touching the store; these are the shapes that
  // must not get through.
  for (const bad of ['', 'short', '../../etc', "a' OR 1=1 --", 'x'.repeat(200), 'has space']) {
    assert.equal(ID.test(bad), false, `accepted: ${bad}`);
  }
  for (const good of ['aaaaaaaaaaaaaaaa', 'A1b2-C3d4_E5f6G7h8']) {
    assert.equal(ID.test(good), true, `rejected: ${good}`);
  }
});

test('no database bound means no store, not a crash', () => {
  assert.equal(storeOf({}), null);
  assert.equal(storeOf(undefined), null);
  // Something bound that is neither D1 nor KV.
  assert.equal(storeOf({ DB: { notADatabase: true } }), null);
});

test('the rate limit counts, expires, and keeps no address', async () => {
  const kvStore = fakeKV();
  const env = { RATE: kvStore };
  for (let i = 0; i < 5; i++) {
    assert.equal(await withinRate(env, '203.0.113.7', { perHour: 5 }), true, `call ${i}`);
  }
  assert.equal(await withinRate(env, '203.0.113.7', { perHour: 5 }), false, 'let a 6th through');

  // A different network is counted separately.
  assert.equal(await withinRate(env, '198.51.100.9', { perHour: 5 }), true);

  // The address itself is never a key — only a hash of it, which cannot be
  // read back into the address it came from.
  for (const key of kvStore._map.keys()) {
    assert.doesNotMatch(key, /203\\.0\\.113\\.7/, `the address is in the key: ${key}`);
  }
});

test('with nothing to count with, writes are allowed rather than blocked', async () => {
  // A missing rate store must not lock everyone out of saving their work.
  assert.equal(await withinRate({}, '203.0.113.7'), true);
  assert.equal(await withinRate({ RATE: fakeKV() }, ''), true);
});
