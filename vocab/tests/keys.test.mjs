/**
 * Several Gemini keys, and when to move between them.
 *
 * The free tier is metered per key, so ten keys is ten times the daily quota.
 * The whole feature is one decision — which failures mean "this key is done"
 * rather than "ask again" — and getting it wrong is expensive in both
 * directions. Rotate on too much and a single malformed request burns all ten
 * keys and leaves nothing for the rest of the day. Rotate on too little and
 * nine keys sit idle while the first sits at its quota.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, geminiKeys, geminiKeyCount, hasGeminiKey, geminiJson } from '../server/gemini.mjs';

test('keys can be given as one variable, in any sane separator', () => {
  configure({ apiKeys: 'AAA,BBB' });
  assert.deepEqual(geminiKeys(), ['AAA', 'BBB'], 'commas');

  configure({ apiKeys: 'AAA\nBBB\nCCC' });
  assert.deepEqual(geminiKeys(), ['AAA', 'BBB', 'CCC'], 'newlines');

  configure({ apiKeys: '  AAA ,  BBB \n CCC  ' });
  assert.deepEqual(geminiKeys(), ['AAA', 'BBB', 'CCC'], 'whitespace was not trimmed');
});

test('a duplicated key is dropped rather than tried twice', () => {
  // Two entries of the same key look like redundancy and are not: when it is
  // exhausted both fail, and the second is a wasted round trip on every
  // request for the rest of the day.
  configure({ apiKeys: 'AAA,BBB,AAA,BBB,AAA' });
  assert.deepEqual(geminiKeys(), ['AAA', 'BBB']);
  assert.equal(geminiKeyCount(), 2);
});

test('the single key still comes first when both are given', () => {
  configure({ apiKey: 'PRIMARY', apiKeys: 'SECOND,THIRD' });
  assert.deepEqual(geminiKeys(), ['PRIMARY', 'SECOND', 'THIRD']);
});

test('no keys is an empty list, not a list with an empty string in it', () => {
  // A list holding "" would be one key that fails every request, and the
  // failure would name a rate limit rather than a missing key.
  configure({});
  assert.deepEqual(geminiKeys(), []);
  assert.equal(hasGeminiKey(), false);

  configure({ apiKey: '', apiKeys: ',, ,\n,' });
  assert.deepEqual(geminiKeys(), []);
  assert.equal(hasGeminiKey(), false);
});

/* The rotation rule, stated the same way the Worker states it. Kept here as
   its own function so the reasoning is testable without a network. */
function keyIsSpent(status, detail) {
  if (status === 429 || status === 403) return true;
  return status === 400 && /API_KEY_INVALID|API key not valid/i.test(detail);
}

test('quota and permission failures move to the next key', () => {
  assert.equal(keyIsSpent(429, 'Quota exceeded for quota metric'), true, 'daily cap');
  assert.equal(keyIsSpent(403, 'API has not been used in project'), true, 'not enabled');
  assert.equal(keyIsSpent(400, 'API_KEY_INVALID'), true, 'dead key');
  assert.equal(keyIsSpent(400, 'API key not valid. Please pass a valid API key.'), true);
});

test('failures that are not the key’s fault do not burn the other nine', () => {
  // Every one of these fails identically on all ten keys. Rotating through
  // them costs ten round trips and ends with the same error.
  assert.equal(keyIsSpent(400, 'Invalid JSON payload received'), false, 'a bad request');
  assert.equal(keyIsSpent(404, 'models/gemini-x is not found'), false, 'a retired model');
  assert.equal(keyIsSpent(503, 'The model is overloaded'), false, 'a busy model');
  assert.equal(keyIsSpent(500, 'Internal error'), false, 'their bug');
});

test('a spent key is reported without ever naming a key', () => {
  // The key travels in the URL, so an error echoing the request back is the
  // one place a key could leak into a log or a reply.
  const scrub = (text) => String(text).replace(/key=[\w-]+/gi, 'key=…');
  const leaky = 'POST https://generativelanguage.googleapis.com/v1/x?key=AIzaSyREAL123 failed';
  assert.doesNotMatch(scrub(leaky), /AIzaSyREAL123/);
  assert.match(scrub(leaky), /key=…/);
});

test('the count is reportable, the keys are not', () => {
  configure({ apiKeys: 'AAA,BBB,CCC' });
  // Health says how many, so a key typed into the wrong variable name — which
  // otherwise looks exactly like no key at all — is visible from outside.
  const health = { ready: hasGeminiKey(), keys: geminiKeyCount() };
  assert.deepEqual(health, { ready: true, keys: 3 });
  assert.doesNotMatch(JSON.stringify(health), /AAA|BBB|CCC/);
});

/* ── the walk itself ──────────────────────────────────────────────────────
 *
 * The rule above decides when to move on; these decide how much the walk is
 * allowed to cost. Ten keys means ten possible round trips per question, and
 * a walk that takes longer than the browser waits reaches the learner as an
 * aborted stream — an error naming neither cause nor fix — even though every
 * part of the deployment is working exactly as designed.
 */

/** A Gemini that answers from a script, recording which key each request used. */
function stubFetch(plan) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(new URL(url).searchParams.get('key'));
    const step = plan.shift() || { status: 500 };
    if (step.status === 200) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"said":"hello"}' }] } }] }),
      };
    }
    return { ok: false, status: step.status, text: async () => step.body || '' };
  };
  return seen;
}

const ASK = { system: 's', user: 'u' };
const SCHEMA = { type: 'object', properties: { said: { type: 'string' } } };

/** Leaves the shared cursor at 0, so a test can name the key it expects. */
async function reset() {
  configure({ apiKey: 'RESET' });
  stubFetch([{ status: 200 }]);
  await geminiJson(ASK, SCHEMA);
}

test('a busy answer is retried on the same key, not from the top of the list', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  await reset();

  configure({ apiKeys: 'AAA,BBB,CCC' });
  // AAA is out of quota; BBB is merely overloaded and answers on the retry.
  const seen = stubFetch([{ status: 429 }, { status: 503 }, { status: 200 }]);
  assert.deepEqual(await geminiJson(ASK, SCHEMA), { said: 'hello' });

  /* The retry used to restart the whole walk, so this was AAA, BBB, AAA,
     BBB, CCC — and with ten keys, twenty round trips for one question, which
     is comfortably longer than the browser is willing to wait. */
  assert.deepEqual(seen, ['AAA', 'BBB', 'BBB']);
});

test('a request that is wrong stops the walk instead of burning every key', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  await reset();

  configure({ apiKeys: 'AAA,BBB,CCC' });
  const seen = stubFetch([{ status: 400, body: 'Invalid JSON payload' }]);
  await assert.rejects(geminiJson(ASK, SCHEMA), /rejected the request/);
  assert.equal(seen.length, 1, 'a malformed request fails identically on all three');
});

test('every key spent is one sentence, and it names no key', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  await reset();

  /* Key-shaped on purpose. The last key's failure is the one reported, and
     the point of the test is that it can quote Google without quoting the
     key — so the keys have to be long enough to be real ones. */
  const pool = [
    'AIzaSyTEST-aaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'AIzaSyTEST-bbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'AIzaSyTEST-ccccccccccccccccccccccccccc',
  ];
  configure({ apiKeys: pool.join(',') });
  const seen = stubFetch([
    { status: 429 }, { status: 429 },
    { status: 429, body: `Quota exceeded for key ${pool[2]}` },
  ]);
  await assert.rejects(geminiJson(ASK, SCHEMA), (err) => {
    assert.match(err.message, /All 3 Gemini keys are exhausted or rejected\./);
    for (const key of pool) {
      assert.ok(!err.message.includes(key), `the message repeated a key back: ${err.message}`);
    }
    return true;
  });
  assert.deepEqual(seen, pool, 'each key is tried exactly once');
});

test('the key that worked is where the next question starts', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  await reset();

  configure({ apiKeys: 'AAA,BBB,CCC' });
  stubFetch([{ status: 429 }, { status: 429 }, { status: 200 }]);
  await geminiJson(ASK, SCHEMA);

  // Not round-robin: spreading requests evenly across ten keys would exhaust
  // all ten on the same day rather than one.
  const seen = stubFetch([{ status: 200 }]);
  await geminiJson(ASK, SCHEMA);
  assert.deepEqual(seen, ['CCC'], 'it went back to a key it had already emptied');
});

test('a key that never answers is stepped over, not waited on forever', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  await reset();

  configure({ apiKeys: 'AAA,BBB' });
  const seen = [];
  globalThis.fetch = async (url) => {
    const key = new URL(url).searchParams.get('key');
    seen.push(key);
    // What a hung connection looks like once the attempt timer fires.
    if (key === 'AAA') throw new Error('no answer within 12s');
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"said":"hello"}' }] } }] }),
    };
  };
  assert.deepEqual(await geminiJson(ASK, SCHEMA), { said: 'hello' });
  assert.deepEqual(seen, ['AAA', 'BBB']);
});
