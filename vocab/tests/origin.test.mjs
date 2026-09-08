/**
 * The empty proxy address means "here", not "nowhere".
 *
 * `AI.proxyUrl` is a fact about the deployment. A full https address points
 * the app at a proxy hosted somewhere else; an empty one means the proxy is
 * whatever origin served the app — which is what the one-upload Pages
 * deployment is, and what `pages-worker.mjs` exists to make possible.
 *
 * Three modules had answered "is there a proxy?" by testing that address for
 * truthiness. The AI still worked, because an empty base makes the routes
 * relative and a relative route resolves to the right place. What broke was
 * everything that asked first: accounts, sync, and the health check that the
 * welcome screen reads to decide whether to offer signing in at all. So a
 * one-origin deployment answered questions about words and quietly refused to
 * hold an account, with nothing on screen to say why.
 *
 * It is a one-character bug (`!base` where `!hasBase` was meant), it is
 * invisible in every build whose address is non-empty — which is every build
 * anyone develops against — and it can only be seen by deploying. Hence a
 * test that reads the source rather than waiting for the deployment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const files = fs.readdirSync(path.join(ROOT, 'js'))
  .filter((f) => f.endsWith('.js') && f !== 'config.js')
  .map((f) => ({ file: `js/${f}`, code: read(`js/${f}`) }));

test('no module decides there is a server by testing the address', () => {
  /* `${proxyBase()}${route}` is the correct use and must stay allowed, so this
     looks only for the address in a boolean position: negated, or either side
     of a && / ||, or alone inside an if. */
  const wrong = [
    /!\s*(?:AI\.)?proxyUrl\b/,
    /!\s*proxyBase\(\)/,
    /\bproxyBase\(\)\s*&&/,
    /&&\s*proxyBase\(\)/,
    /\bAI\.proxyUrl\s*(?:&&|\|\|)/,
    /(?:&&|\|\|)\s*AI\.proxyUrl\b/,
    /if\s*\(\s*!?\s*(?:AI\.proxyUrl|proxyBase\(\))\s*\)/,
  ];
  // Prose about the bug is not the bug: this file's own explanation quotes the
  // wrong pattern, and so may a comment warning the next person off it.
  const isComment = (line) => /^\s*(?:\/\/|\/?\*)/.test(line);

  for (const { file, code } of files) {
    for (const [i, line] of code.split('\n').entries()) {
      if (isComment(line)) continue;
      for (const pattern of wrong) {
        assert.ok(!pattern.test(line),
          `${file}:${i + 1} asks whether there is a proxy by testing its address — `
          + `use proxyHere(), which is true for the empty address too:\n    ${line.trim()}`);
      }
    }
  }
});

test('proxyHere is what the three gates ask', () => {
  // Named individually: each is a surface that goes silently missing rather
  // than failing loudly, which is why the bug survived a deployment.
  const gates = [
    ['js/ai.js', 'serverInfo', 'the health check the welcome screen reads'],
    ['js/auth.js', 'possible', 'whether accounts can be offered'],
    ['js/sync.js', 'enabled', 'whether work can be saved to a server'],
  ];
  for (const [file, fn, what] of gates) {
    const code = read(file);
    const at = code.indexOf(fn);
    assert.ok(at > 0, `${file} no longer has ${fn}`);
    // Within the function's own body, not the whole file.
    const body = code.slice(at, at + 400);
    assert.match(body, /proxyHere\(\)/,
      `${file}: ${fn}() decides ${what} and must ask proxyHere(), not the address itself`);
  }
});

test('proxyHere is false only where a relative route cannot reach a server', () => {
  const code = read('js/ai.js');
  const line = code.split('\n').find((l) => l.includes('export const proxyHere'));
  assert.ok(line, 'proxyHere is gone from ai.js');
  const decl = code.slice(code.indexOf(line), code.indexOf(line) + 220);
  // A configured address is enough on its own; otherwise the page's own
  // protocol decides, so a file:// page is correctly told there is nothing.
  assert.match(decl, /AI\.proxyUrl/);
  assert.match(decl, /https\?/);
});

test('the one-origin build is the one that ships with an empty address', () => {
  /* The repository's own config points at the standalone Worker, and the
     packaging step empties it for the archive that carries `_worker.js`.
     If that substitution ever stops matching the line it edits, the archive
     goes out pointing at the wrong server — so the shape of the line and the
     shape of the edit are checked against each other here. */
  const config = read('js/config.js');
  const line = config.split('\n').find((l) => l.startsWith('  proxyUrl: '));
  assert.ok(line, 'config.js has no top-level proxyUrl line');
  assert.match(line, /^ {2}proxyUrl: '[^']*',$/,
    'package-web.sh rewrites this exact shape; changing it silently breaks the one-origin archive');

  const packager = fs.readFileSync(path.join(ROOT, '..', 'scripts', 'package-web.sh'), 'utf8');
  assert.match(packager, /proxyUrl/,
    'the packaging step no longer touches proxyUrl, so the one-origin archive would call the standalone Worker');
});
