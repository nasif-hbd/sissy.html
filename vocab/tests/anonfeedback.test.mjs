/**
 * Anonymous feedback.
 *
 * "Anonymous" is a claim, and a claim only means something if it holds when
 * the claim is inconvenient — when a caller sends identifying fields anyway,
 * when a field is added to the report later, when two notes arrive at once.
 * These are those cases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { anonymise, manifestOf, feedbackAsText } from '../js/feedback.js';
import worker from '../server/worker.mjs';

const FULL = {
  kind: 'bug', mood: 'bad', text: 'The quiz froze on the third question.',
  from: 'someone@example.com', at: '2026-09-01T22:47:31.000Z',
  context: { view: 'test', provider: 'gemini', level: 'B2', words: 412, screen: '1280x900' },
};

/* ── on the device ──────────────────────────────────────────────────────── */

test('an anonymous report carries what was said and nothing about who said it', () => {
  const out = anonymise(FULL);
  assert.equal(out.text, FULL.text, 'the report itself is the point of sending it');
  assert.equal(out.kind, 'bug');
  assert.equal(out.anonymous, true);
  assert.equal(out.from, undefined);
  assert.equal(out.context, undefined);
});

test('a field added to the report later is dropped, not carried through', () => {
  // Built by naming what may go, so a new field is excluded by default rather
  // than included by an omission nobody notices.
  const out = anonymise({ ...FULL, deviceId: 'abc-123', email: 'x@y.z', ip: '1.2.3.4' });
  assert.deepEqual(Object.keys(out).sort(), ['anonymous', 'at', 'kind', 'mood', 'text']);
});

test('the timestamp is blunted, so two notes cannot be tied together by their clocks', () => {
  const a = anonymise({ ...FULL, at: '2026-09-01T22:47:31.000Z' });
  const b = anonymise({ ...FULL, at: '2026-09-01T22:51:09.000Z' });
  assert.equal(a.at, b.at, 'four minutes apart must not be distinguishable');
  assert.match(a.at, /T22:00:00/);
});

test('the text form of an anonymous report states that it is one', () => {
  const text = feedbackAsText(anonymise(FULL));
  assert.match(text, /sent anonymously/);
  assert.doesNotMatch(text, /gemini|B2|1280x900/, 'the context must not come back through the wording');
});

/* ── what the reader is shown ───────────────────────────────────────────── */

test('the list shown to the reader is built from the payload, not written by hand', () => {
  const anon = manifestOf(anonymise(FULL));
  const withheld = anon.filter((r) => !r.sent).map((r) => r.label);
  for (const label of ['Your email', 'Which screen you were on', 'Which AI engine',
                       'Your level', 'How many words in your deck', 'Your window size']) {
    assert.ok(withheld.includes(label), `"${label}" is sent but shown as withheld`);
  }

  // And a signed report shows the same fields as sent, or the list is decoration.
  const signed = manifestOf(FULL);
  assert.ok(signed.find((r) => r.label === 'Your email').sent);
  assert.ok(signed.find((r) => r.label === 'Which AI engine').sent);
});

test('a signed report with no email given still shows the email as withheld', () => {
  const rows = manifestOf({ ...FULL, from: '' });
  assert.equal(rows.find((r) => r.label === 'Your email').sent, false);
});

/* ── and on the server, which is the half that can lie ──────────────────── */

function inbox() {
  const store = new Map();
  return {
    store,
    put: async (k, v) => { store.set(k, v); },
    get: async (k) => store.get(k) ?? null,
    list: async () => ({ keys: [...store.keys()].sort().map((name) => ({ name })) }),
  };
}
const post = (path, body, env) => worker.fetch(new Request(`https://p.example${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), env);

test('the server strips identity from an anonymous note even when it is sent one', async () => {
  const FEEDBACK = inbox();
  // A tampered client, an old build, a bug — the server does not get to trust it.
  await post('/api/feedback', {
    anonymous: true, kind: 'bug', text: 'broken',
    from: 'someone@example.com',
    context: { view: 'test', provider: 'gemini', level: 'B2' },
  }, { FEEDBACK });

  const stored = JSON.parse([...FEEDBACK.store.values()][0]);
  assert.equal(stored.from, '', 'an address arrived and was kept');
  assert.equal(stored.context, null, 'context arrived and was kept');
  assert.equal(stored.text, 'broken', 'and the report itself survived');
});

test('a signed note keeps what the sender chose to attach', async () => {
  const FEEDBACK = inbox();
  await post('/api/feedback', { kind: 'idea', text: 'add Spanish', from: 'me@example.com',
                                context: { view: 'words' } }, { FEEDBACK });
  const stored = JSON.parse([...FEEDBACK.store.values()][0]);
  assert.equal(stored.from, 'me@example.com');
  assert.deepEqual(stored.context, { view: 'words' });
});

test('two notes in the same millisecond do not overwrite each other', async () => {
  const FEEDBACK = inbox();
  await Promise.all([
    post('/api/feedback', { anonymous: true, text: 'first' }, { FEEDBACK }),
    post('/api/feedback', { anonymous: true, text: 'second' }, { FEEDBACK }),
  ]);
  assert.equal(FEEDBACK.store.size, 2, 'losing anonymous feedback loses it for good');
});

test('an empty note is refused rather than stored', async () => {
  const FEEDBACK = inbox();
  assert.equal((await post('/api/feedback', { text: '   ' }, { FEEDBACK })).status, 400);
  assert.equal(FEEDBACK.store.size, 0);
});

test('with no inbox bound the proxy says so instead of accepting and dropping', async () => {
  const res = await post('/api/feedback', { text: 'hello' }, {});
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /FEEDBACK/);
});

/* ── reading it back ────────────────────────────────────────────────────── */

test('the inbox stays shut unless a token is configured', async () => {
  const FEEDBACK = inbox();
  await post('/api/feedback', { text: 'private' }, { FEEDBACK });
  // An unlocked proxy must not hand its inbox to whoever asks.
  assert.equal((await post('/api/feedback/list', {}, { FEEDBACK })).status, 403);
  assert.equal((await post('/api/feedback/list', { token: '' }, { FEEDBACK })).status, 403);
});

test('a wrong token is refused, and a right one is answered', async () => {
  const FEEDBACK = inbox();
  const env = { FEEDBACK, FEEDBACK_TOKEN: 'the-real-token' };
  await post('/api/feedback', { text: 'one' }, env);
  await new Promise((done) => setTimeout(done, 2));   // so the two differ in time
  await post('/api/feedback', { text: 'two' }, env);

  assert.equal((await post('/api/feedback/list', { token: 'the-real-toke' }, env)).status, 401);
  assert.equal((await post('/api/feedback/list', { token: 'THE-REAL-TOKEN' }, env)).status, 401);

  const ok = await (await post('/api/feedback/list', { token: 'the-real-token' }, env)).json();
  assert.equal(ok.data.length, 2);
  assert.equal(ok.data[0].text, 'two', 'newest first');
});
