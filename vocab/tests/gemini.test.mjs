/**
 * The Gemini engine.
 *
 * Every check here is a bug that shipped. All three were invisible to the
 * other tests because they live in the seam between the browser, the proxy and
 * Google — a place where nothing throws, it just quietly returns nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { forGemini, geminiModel, geminiStream, GEMINI_MODEL, configure }
  from '../server/gemini.mjs';

/* The streaming tests stub fetch, so the key is never used — but it is checked
   before the request is built, because "no key configured" is a better error
   than whatever Google returns for a request with an empty one. */
configure({ apiKey: 'test-key-not-used-by-the-stub' });

/* ── the schema Gemini will accept ──────────────────────────────────────── */

test('the JSON-Schema keywords Gemini rejects are stripped', () => {
  const trimmed = forGemini({
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: {
      word: { type: 'string' },
      senses: { type: 'array', items: { type: 'object', additionalProperties: false,
                                        properties: { gloss: { type: 'string' } } } },
    },
  });
  assert.equal(trimmed.$schema, undefined);
  assert.equal(trimmed.additionalProperties, undefined);
  assert.equal(trimmed.properties.senses.items.additionalProperties, undefined,
    'nested schemas are trimmed too, or the request is rejected on the way in');
  assert.equal(trimmed.properties.word.type, 'string', 'and nothing else is lost');
});

/* ── the model actually called ──────────────────────────────────────────── */

test('a model belonging to another engine never reaches Google', () => {
  // The browser sent one `model` field whichever engine was chosen, so Gemini
  // was asked for "claude-haiku-4-5" and answered 404 to every request.
  assert.equal(geminiModel('claude-haiku-4-5'), GEMINI_MODEL);
  assert.equal(geminiModel('gpt-4o'), GEMINI_MODEL);
  assert.equal(geminiModel(''), GEMINI_MODEL);
  assert.equal(geminiModel(undefined), GEMINI_MODEL);
  assert.equal(geminiModel(null), GEMINI_MODEL);
});

test('a Gemini model the caller asked for is honoured', () => {
  for (const id of ['gemini-flash-lite-latest', 'gemini-3.5-flash', 'gemini-2.5-pro',
                    'gemma-4-31b-it']) {
    assert.equal(geminiModel(id), id, `${id} should pass through`);
  }
});

test('a model id cannot smuggle a path or a query onto the URL', () => {
  for (const bad of ['gemini/../../v1/other', 'gemini-x?key=stolen', 'gemini x',
                     'gemini:generateContent']) {
    assert.equal(geminiModel(bad), GEMINI_MODEL, `${bad} should not be used verbatim`);
  }
});

/* ── the stream ─────────────────────────────────────────────────────────── */

/** Stand in for Google: serve `chunks` as the body of one OK response. */
function serve(chunks) {
  const encoder = new TextEncoder();
  return async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  });
}

const frame = (text) => `data: {"candidates":[{"content":{"parts":[{"text":${JSON.stringify(text)}}]}}]}`;

test('CRLF-separated frames are read — Google does not send bare newlines', async () => {
  // The parser split on "\n\n", which matches nothing in "\r\n\r\n", so every
  // frame stayed in the buffer and the tutor chat streamed silence.
  const real = globalThis.fetch;
  globalThis.fetch = serve([`${frame('Hello')}\r\n\r\n${frame(' world')}\r\n\r\n`]);
  try {
    const seen = [];
    const full = await geminiStream({ user: 'hi' }, (t) => seen.push(t));
    assert.deepEqual(seen, ['Hello', ' world']);
    assert.equal(full, 'Hello world');
  } finally { globalThis.fetch = real; }
});

test('bare-newline frames still work, in case the wire format changes back', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = serve([`${frame('a')}\n\n${frame('b')}\n\n`]);
  try {
    const seen = [];
    await geminiStream({ user: 'hi' }, (t) => seen.push(t));
    assert.deepEqual(seen, ['a', 'b']);
  } finally { globalThis.fetch = real; }
});

test('a frame split across two network chunks is not lost', async () => {
  const one = frame('together');
  const real = globalThis.fetch;
  globalThis.fetch = serve([one.slice(0, 20), `${one.slice(20)}\r\n\r\n`]);
  try {
    const seen = [];
    await geminiStream({ user: 'hi' }, (t) => seen.push(t));
    assert.deepEqual(seen, ['together']);
  } finally { globalThis.fetch = real; }
});

test('a last frame with no blank line after it still arrives', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = serve([`${frame('first')}\r\n\r\n${frame('last')}`]);
  try {
    const seen = [];
    await geminiStream({ user: 'hi' }, (t) => seen.push(t));
    assert.deepEqual(seen, ['first', 'last'], 'the tail of the buffer is a frame too');
  } finally { globalThis.fetch = real; }
});

test('keep-alive and comment lines are skipped rather than parsed', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = serve([`: ping\r\n\r\n${frame('real')}\r\n\r\ndata: not json\r\n\r\n`]);
  try {
    const seen = [];
    await geminiStream({ user: 'hi' }, (t) => seen.push(t));
    assert.deepEqual(seen, ['real'], 'a malformed frame must not end the stream');
  } finally { globalThis.fetch = real; }
});

/* ── what the app offers ────────────────────────────────────────────────── */

test('every model the app offers is one the Gemini engine will actually call', async () => {
  const { AI } = await import('../js/config.js');
  assert.ok(AI.geminiModels.length >= 2, 'expected a choice, not a single id');
  for (const { id, label } of AI.geminiModels) {
    assert.equal(geminiModel(id), id,
      `Settings offers "${id}", which the server would silently swap for the default`);
    assert.ok(label && label.length > 3, `${id} needs a label a person can choose by`);
  }
});

test('the default model is the first one offered, so Settings opens on the truth', () => {
  assert.ok(geminiModel(GEMINI_MODEL) === GEMINI_MODEL, 'the default must be a Gemini id');
});

/* ── saying who answered ────────────────────────────────────────────────── */

/**
 * Every AI surface was labelled "Claude" in the source, so with Gemini chosen
 * the app said Claude while Google answered — and nothing on screen told you
 * which engine had written what you were reading. These keep it that way only
 * if someone means it.
 */
test('no screen names an engine it has not asked which engine is answering', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const sources = [
    ...fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'))
      .map((f) => [`js/${f}`, fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')]),
    ['index.html', fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')],
  ];

  const offences = [];
  for (const [file, source] of sources) {
    let inBlockComment = false;
    source.split('\n').forEach((line, i) => {
      // Prose about the engines belongs in the comments; only what reaches a
      // screen is a claim about who answered.
      const trimmed = line.trim();
      if (inBlockComment) { if (trimmed.includes('*/')) inBlockComment = false; return; }
      if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlockComment = true; return; }
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('<!--')) return;
      // config.js names the engines once, as the labels of the engines
      // themselves; a key name or an API URL is not a claim about who
      // answered; and the setup copy names both, which cannot mislead.
      if (file === 'js/config.js') return;
      if (/ANTHROPIC_API_KEY|GEMINI_API_KEY|console\.anthropic|aistudio|claude-\w/.test(line)) return;
      if (/Claude or Gemini|Gemini or Claude/.test(line)) return;
      if (/['"`][^'"`]*\b(Claude|Gemini)\b[^'"`]*['"`]|>[^<]*\b(Claude|Gemini)\b/.test(line)) {
        offences.push(`${file}:${i + 1} ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(offences, [],
    `these name one engine where AIClient.engine should ask which is live:\n${offences.join('\n')}`);
});

test('every surface that shows AI output has somewhere to ask a follow-up', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

  // A panel of AI prose used to be a dead end: asking a follow-up meant
  // leaving the screen and retyping the word in another tab.
  const slots = [...html.matchAll(/<div class="ai-slot" id="(\w+)"/g)].map((m) => m[1]);
  assert.ok(slots.length >= 2, `expected the card and the test panels, found ${slots}`);
  for (const slot of slots) {
    const block = html.slice(html.indexOf(`id="${slot}"`));
    const panel = block.slice(0, block.indexOf('</div>\n', block.indexOf('ai-slot__body')) + 400);
    assert.match(panel, /ai-slot__ask/, `${slot} has no way on from what it says`);
  }
  assert.match(app, /function askAbout\(/, 'the shared handoff is what they all call');
});
