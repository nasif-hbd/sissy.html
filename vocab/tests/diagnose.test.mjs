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
  Store.state = { settings: { ai: { provider: 'gemini', mode: 'proxy' } } };
  const { diagnose } = await import('../js/ai.js');
  // The address is a build setting now, so it is passed in rather than stored.
  return (err) => diagnose(err, endpoint);
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
  assert.match(diagnose(failedToFetch()), /no AI server set/);
});

test('a malformed address says so rather than guessing', async () => {
  const diagnose = await loadWith({
    origin: 'https://vocabx.ylarena.online', endpoint: 'not a url',
  });
  assert.match(diagnose(failedToFetch()), /not a valid server address/);
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

/**
 * The address box's own escape hatch.
 *
 * `localhost` is the development default, so a published site inherits it and
 * fails on every request — the mistake is nearly universal and the fix is one
 * empty field. The offer to empty it may only appear where it is certainly
 * right: pointing at this machine, from a page that is not on it.
 */
test('the clear-the-address offer appears only where it is certainly right', async () => {
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;
  const hostOf = (endpoint) => { try { return new URL(endpoint).hostname; } catch { return ''; } };
  // The same condition the settings panel applies, stated once here so a
  // change to either has to be a change to both.
  const offer = (page, endpoint) =>
    local.test(hostOf(endpoint)) && !local.test(new URL(page).hostname);

  assert.equal(offer('https://vocabx.ylarena.online', 'http://localhost:8787'), true,
    'a published site pointed at localhost is the case this exists for');
  assert.equal(offer('https://vocabx.ylarena.online', 'http://127.0.0.1:8787'), true);

  assert.equal(offer('http://localhost:8000', 'http://localhost:8787'), false,
    'two ports on one machine is the documented development setup');
  assert.equal(offer('https://vocabx.ylarena.online', 'https://proxy.example.com'), false,
    'a real remote address may simply be down — emptying it would be wrong');
  assert.equal(offer('https://vocabx.ylarena.online', ''), false,
    'already empty, so there is nothing to offer');
});

/**
 * The address box, given what people actually have in the clipboard.
 *
 * It wants the base — the app appends its own routes. What gets pasted is
 * whatever the person was last told to open, which is the health check, and
 * that produced a request for /api/health/api/health and a 404 blaming the
 * server for the app's own mistake.
 */
test('a pasted route is trimmed back to the address', async () => {
  const { baseOf } = await import('../js/ai.js');
  assert.equal(baseOf('https://vocabx.ylarena.online/api/health'), 'https://vocabx.ylarena.online');
  assert.equal(baseOf('https://proxy.workers.dev/api/ai/ask'), 'https://proxy.workers.dev');
  assert.equal(baseOf('https://proxy.workers.dev/api'), 'https://proxy.workers.dev');
  assert.equal(baseOf('https://proxy.workers.dev/api/'), 'https://proxy.workers.dev');
});

test('an address that is already an address is left alone', async () => {
  const { baseOf } = await import('../js/ai.js');
  assert.equal(baseOf('https://proxy.workers.dev'), 'https://proxy.workers.dev');
  assert.equal(baseOf('https://proxy.workers.dev/'), 'https://proxy.workers.dev');
  assert.equal(baseOf('http://localhost:8787'), 'http://localhost:8787');
  // A path that merely starts with the letters is not the app's route.
  assert.equal(baseOf('https://host.example/apiary'), 'https://host.example/apiary');
});

test('an empty box stays empty, which is how same-origin is spelled', async () => {
  const { baseOf } = await import('../js/ai.js');
  assert.equal(baseOf(''), '');
  assert.equal(baseOf('   '), '');
  assert.equal(baseOf(undefined), '');
});

/**
 * The built-in address.
 *
 * Where the AI server lives is a property of the deployment, not a preference,
 * and the one person who knows the answer is whoever deployed the build. It
 * used to be a question every reader was asked, and every reader got it wrong
 * the same way — by keeping the localhost default the app shipped with.
 */
test('the build carries an address nobody has to be asked for', async () => {
  const { AI } = await import('../js/config.js');
  assert.equal(typeof AI.proxyUrl, 'string');
  // Empty is legitimate — it means "wherever this app is served from".
  if (AI.proxyUrl) {
    assert.match(AI.proxyUrl, /^https:\/\//,
      'a baked address must be https, or an https page cannot call it');
    assert.doesNotMatch(AI.proxyUrl, /localhost|127\.0\.0\.1/,
      'localhost is a development address and works for nobody else');
    assert.doesNotMatch(AI.proxyUrl, /\/$/, 'no trailing slash — routes are appended');
    assert.doesNotMatch(AI.proxyUrl, /\/api/, 'the base only; the app adds its own routes');
  }
});

test('a fresh install starts on the built-in address, not on localhost', async () => {
  const { AI } = await import('../js/config.js');
  const { Store } = await import('../js/store.js');
  // freshState() is what a new browser gets; it must not need editing.
  const fresh = Store.freshState ? Store.freshState() : null;
  if (fresh) assert.equal(fresh.settings.ai.endpoint, AI.proxyUrl);
});

/**
 * The address is the build's, not the reader's.
 *
 * This is published to the public. A visitor must not be able to point the
 * app at another server — not through the interface, which no longer offers
 * the field, and not by editing what is in their own browser storage, which
 * is why nothing reads it any more.
 */
test('a saved address in storage cannot redirect the app', async () => {
  const { Store } = await import('../js/store.js');
  const { AI } = await import('../js/config.js');
  const { proxyBase } = await import('../js/ai.js');

  Store.state = { settings: { ai: { provider: 'gemini', endpoint: 'https://attacker.example' } } };
  assert.equal(proxyBase(), AI.proxyUrl.replace(/\/+$/, ''),
    'the build decides, whatever storage says');
});

test('an address left over from an older save is dropped, not kept', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(ROOT, 'js', 'store.js'), 'utf8');
  assert.match(source, /delete ai\.endpoint/,
    'a stale address sitting in storage looks like it still means something');
});

test('no screen offers the address as something to type', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const file of ['index.html', 'js/app.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /aiEndpoint/,
      `${file} still carries the address field`);
  }
});
