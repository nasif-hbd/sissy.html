/**
 * Design-system tests.  Run with:  node --test
 *
 * The stylesheet is the single source of truth for colour, and JS injects a few
 * `var(--token)` values inline (the deck-state spine, its legend). A rename in
 * one place and silence in the other paints nothing at all — invalid custom
 * properties fail quietly, so nothing throws and no test of behaviour notices.
 * These checks are the tripwire for that, plus the two other rules the design
 * actually depends on: both themes carry the same tokens, and the vendored
 * typefaces exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const css = read('styles.css');
const js = fs.readdirSync(path.join(ROOT, 'js'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ file: `js/${f}`, source: read(`js/${f}`) }));

/** Every `:root…{ }` block in the sheet, including those inside media queries. */
function rootBlocks() {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter(({ selector }) => selector.includes(':root'));
}

/** Custom properties declared by the blocks whose selector `matches`. */
function declaredWhere(matches) {
  const names = new Set();
  for (const { selector, body } of rootBlocks()) {
    if (!matches(selector)) continue;
    for (const [, name] of body.matchAll(/(--[\w-]+)\s*:/g)) names.add(name);
  }
  return names;
}

const declaredIn = (theme) =>
  declaredWhere((selector) => selector.includes(`[data-theme="${theme}"]`));

// The default palette: bare `:root`, plus the paper block grouped with it.
const baseTokens = declaredWhere((selector) =>
  !selector.includes('[data-theme=') || selector.includes('[data-theme="paper"]'));
/** Themes other than the default, read from the stylesheet itself. */
const THEMES = [...new Set([...css.matchAll(/:root\[data-theme="(\w+)"\]/g)].map((m) => m[1]))]
  .filter((name) => name !== 'auto' && name !== 'paper');

/* Type and metric tokens are theme-independent; colour must be restated in
   every theme or that theme silently inherits the default palette. */
/*
 * Tokens a theme is allowed to leave alone. Colour is what a theme is for; a
 * tap target and a panel width are the same whichever one is on. Type and
 * corner radius are on this list because a theme MAY set them — Iris carries
 * its own face and a wider radius — but is not required to.
 */
const STRUCTURAL = new Set([
  '--sans', '--text', '--mono', '--radius', '--radius-sm', '--tap', '--maxw', '--shell', '--rail',
  '--rail-w', '--chat-min', '--body-size', '--body-leading', '--tracking-lg', '--tracking-md',
]);

test('the default palette declares a full set of tokens', () => {
  assert.ok(baseTokens.size > 20, `only ${baseTokens.size} tokens found — did :root move?`);
  for (const required of ['--paper', '--card', '--ink', '--rule', '--edge', '--sans',
                          '--accent', '--danger', '--warn', '--ok', '--info']) {
    assert.ok(baseTokens.has(required), `missing ${required}`);
  }
});

test('the stylesheet carries the themes the app offers', () => {
  const config = read('js/config.js');
  const offered = [...config.matchAll(/\{ id: '(\w+)'/g)].map((m) => m[1]);
  assert.ok(offered.length >= 3, 'expected at least three themes in config.js');
  for (const id of offered) {
    if (id === 'auto') continue;   // auto resolves to another palette
    const declared = id === 'paper' || css.includes(`:root[data-theme="${id}"]`);
    assert.ok(declared, `config offers "${id}" but styles.css has no palette for it`);
  }
});

test('no theme invents a token the default palette lacks', () => {
  for (const theme of THEMES) {
    const orphans = [...declaredIn(theme)].filter((t) => !baseTokens.has(t));
    assert.deepEqual(orphans, [], `"${theme}" declares tokens nothing else defines: ${orphans}`);
  }
});

test('every theme restates every colour the default palette sets', () => {
  for (const theme of THEMES) {
    const declared = declaredIn(theme);
    const missing = [...baseTokens].filter((t) => !STRUCTURAL.has(t) && !declared.has(t));
    assert.deepEqual(missing, [], `"${theme}" would inherit these from the default: ${missing}`);
  }
});

test('every var() referenced in the stylesheet resolves to a declared token', () => {
  const referenced = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const unresolved = [...referenced].filter((t) => !baseTokens.has(t) && !t.startsWith('--sw-'));
  assert.deepEqual(unresolved, [], `styles.css uses undeclared tokens: ${unresolved}`);
});

test('every var() injected from JS resolves to a declared token', () => {
  const unresolved = [];
  for (const { file, source } of js) {
    for (const [, token] of source.matchAll(/var\((--[\w-]+)/g)) {
      if (!baseTokens.has(token)) unresolved.push(`${file} → ${token}`);
    }
  }
  assert.deepEqual(unresolved, [], `JS paints with undeclared tokens: ${unresolved}`);
});

test('the vendored typefaces are actually present', () => {
  const sources = [...css.matchAll(/url\("(fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(sources.length >= 1, 'expected at least one @font-face source');
  for (const src of sources) {
    const file = path.join(ROOT, src);
    assert.ok(fs.existsSync(file), `${src} is declared but not committed`);
    const head = fs.readFileSync(file).subarray(0, 4).toString('latin1');
    assert.equal(head, 'wOF2', `${src} is not a woff2 file`);
  }
});

test('every icon reference resolves to a symbol on the sheet', () => {
  const html = read('index.html');
  const symbols = new Set([...html.matchAll(/<symbol id="(i-[\w-]+)"/g)].map((m) => m[1]));
  const jsRefs = js.flatMap(({ source }) =>
    [...source.matchAll(/`#i-\$\{name\}`|icon\('([\w-]+)'/g)].map((m) => m[1]).filter(Boolean));
  const used = new Set([
    ...[...html.matchAll(/<use href="#(i-[\w-]+)"/g)].map((m) => m[1]),
    ...jsRefs.map((n) => `i-${n}`),
  ]);

  const missing = [...used].filter((id) => !symbols.has(id));
  assert.deepEqual(missing, [], `referenced but not drawn: ${missing}`);

  const unused = [...symbols].filter((id) => !used.has(id));
  assert.deepEqual(unused, [], `drawn but never used — drop them: ${unused}`);
});

test('every symbol declares the shared 24x24 grid', () => {
  const html = read('index.html');
  const odd = [...html.matchAll(/<symbol id="(i-[\w-]+)"([^>]*)>/g)]
    .filter(([, , attrs]) => !attrs.includes('viewBox="0 0 24 24"'))
    .map(([, id]) => id);
  assert.deepEqual(odd, [], `these would render at the wrong scale: ${odd}`);
});

test('the interface carries no emoji — printer\'s marks only', () => {
  // Deliberately narrow: the design *does* use typographic marks from the
  // Dingbats and Misc Symbols blocks (☞ ❦ † ✕ ▌). What must never come back is
  // pictographic emoji, or the variation selector that renders a text symbol
  // in emoji presentation.
  const emoji = /[\u{1F000}-\u{1FAFF}\u{FE0F}\u{2728}\u{2705}\u{274C}\u{2B50}\u{2757}]/u;
  for (const { file, source } of [{ file: 'index.html', source: read('index.html') }, ...js]) {
    const hit = source.split('\n').findIndex((line) => emoji.test(line));
    assert.equal(hit, -1, `${file}:${hit + 1} contains emoji: ${source.split('\n')[hit]?.trim()}`);
  }
});

test('the build marker matches the service worker cache it ships with', () => {
  // They are bumped together, and a mismatch means the browser can be told it
  // is running a build whose files it does not actually have.
  const declared = read('js/config.js').match(/build:\s*'([^']+)'/)?.[1];
  const cache = read('sw.js').match(/CACHE = 'vocabx-(v\d+)'/)?.[1];
  assert.ok(declared, 'APP.build is missing');
  assert.equal(declared, cache,
    `Settings would report ${declared} while the cache is ${cache} — bump both`);
});
