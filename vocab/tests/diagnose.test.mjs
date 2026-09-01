/**
 * What the app says when the request never left the browser.
 *
 * A browser reports every one of these as the same `TypeError: Failed to
 * fetch` — wrong scheme, wrong host, server down, origin not allowed — and
 * showing that sentence verbatim is what left someone on a published site
 * reading "Could not reach Gemini: Failed to fetch" with no idea that the
 * server address still pointed at their own laptop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** The module reads `location` and Store; stand both up before importing it. */
async function loadWith({ origin, endpoint }) {
  const url = new URL(origin);
  globalThis.location = { protocol: url.protocol, hostname: url.hostname,
                          host: url.host, origin: url.origin };
  const { Store } = await import('../js/store.js');
  Store.state = { settings: { ai: { endpoint, provider: 'gemini', mode: 'proxy' } } };
  const { diagnose } = await import('../js/ai.js');
  return diagnose;
}

const failedToFetch = () => Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' });

test('a published page pointed at localhost is told exactly that', async () => {
  const diagnose = await loadWith({
    origin: 'https://vocabx.ylarena.online', endpoint: 'http://localhost:8787',
  });
  const said = diagnose(failedToFetch());
  assert.match(said, /this computer/, 'it must name the actual mistake');
  assert.match(said, /vocabx\.ylarena\.online/, 'and the page that cannot reach it');
  assert.match(said, /vocab\/server/, 'and where the thing to host lives');
  assert.doesNotMatch(said, /Failed to fetch/, "the browser's own sentence helps nobody");
});

test('the same address from a local page is not called a mistake', async () => {
  const diagnose = await loadWith({
    origin: 'http://localhost:8000', endpoint: 'http://localhost:8787',
  });
  // Running both on one machine is the documented development setup.
  const said = diagnose(failedToFetch());
  assert.doesNotMatch(said, /this computer/);
  assert.match(said, /did not answer/, 'here the server really is just down');
  assert.match(said, /ALLOWED_ORIGIN/, 'and the other likely cause is named');
});

test('an https page with an http server is told browsers block it', async () => {
  const diagnose = await loadWith({
    origin: 'https://vocabx.ylarena.online', endpoint: 'http://api.example.com',
  });
  const said = diagnose(failedToFetch());
  assert.match(said, /https/, 'and told what to use instead');
  assert.match(said, /api\.example\.com/);
});

test('an empty address is a setting to fill in, not a network fault', async () => {
  const diagnose = await loadWith({ origin: 'https://vocabx.ylarena.online', endpoint: '   ' });
  assert.match(diagnose(failedToFetch()), /no server address is set/);
});

test('a malformed address says so rather than guessing', async () => {
  const diagnose = await loadWith({
    origin: 'https://vocabx.ylarena.online', endpoint: 'not a url',
  });
  assert.match(diagnose(failedToFetch()), /not a valid address/);
});

test('a timeout is reported as a timeout, not as unreachable', async () => {
  const diagnose = await loadWith({
    origin: 'https://vocabx.ylarena.online', endpoint: 'https://api.example.com',
  });
  const said = diagnose(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }));
  assert.match(said, /did not answer within/);
});

test('an error the server actually sent is passed through untouched', async () => {
  const diagnose = await loadWith({
    origin: 'https://vocabx.ylarena.online', endpoint: 'https://api.example.com',
  });
  // The proxy reached Google and Google refused: that message is the useful one.
  const said = diagnose(new Error('Gemini rejected the key (401).'));
  assert.equal(said, 'Gemini rejected the key (401).');
});
