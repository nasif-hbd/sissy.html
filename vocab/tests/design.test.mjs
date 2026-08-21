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

/** Custom properties declared in a `:root…{ }` block. */
function declaredIn(selectorFragment) {
  const blocks = [...css.matchAll(/:root([^{]*)\{([^}]*)\}/g)]
    .filter(([, sel]) => (selectorFragment ? sel.includes(selectorFragment) : sel.trim() === ''));
  const names = new Set();
  for (const [, , body] of blocks) {
    for (const [, name] of body.matchAll(/(--[\w-]+)\s*:/g)) names.add(name);
  }
  return names;
}

const lightTokens = declaredIn('');
const darkTokens = declaredIn('[data-theme="dark"]');

test('the light palette declares a full set of tokens', () => {
  assert.ok(lightTokens.size > 20, `only ${lightTokens.size} tokens found — did :root move?`);
  for (const required of ['--paper', '--card', '--ink', '--rule', '--accent', '--edge', '--serif']) {
    assert.ok(lightTokens.has(required), `missing ${required}`);
  }
});

test('every colour token overridden for ink also exists on paper', () => {
  const orphans = [...darkTokens].filter((t) => !lightTokens.has(t));
  assert.deepEqual(orphans, [], `dark theme declares tokens the light theme never defines: ${orphans}`);
});

test('the ink theme restates every colour the paper theme sets', () => {
  // Type and metric tokens are theme-independent; colour must be restated or
  // the dark theme silently inherits a paper value.
  const typographic = new Set(['--serif', '--text', '--grotesk', '--mono', '--radius', '--tap', '--maxw']);
  const missing = [...lightTokens].filter((t) => !typographic.has(t) && !darkTokens.has(t));
  assert.deepEqual(missing, [], `these are only defined for the light theme: ${missing}`);
});

test('every var() referenced in the stylesheet resolves to a declared token', () => {
  const referenced = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const unresolved = [...referenced].filter((t) => !lightTokens.has(t));
  assert.deepEqual(unresolved, [], `styles.css uses undeclared tokens: ${unresolved}`);
});

test('every var() injected from JS resolves to a declared token', () => {
  const unresolved = [];
  for (const { file, source } of js) {
    for (const [, token] of source.matchAll(/var\((--[\w-]+)/g)) {
      if (!lightTokens.has(token)) unresolved.push(`${file} → ${token}`);
    }
  }
  assert.deepEqual(unresolved, [], `JS paints with undeclared tokens: ${unresolved}`);
});

test('the vendored typefaces are actually present', () => {
  const sources = [...css.matchAll(/url\("(fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(sources.length >= 3, 'expected at least three @font-face sources');
  for (const src of sources) {
    const file = path.join(ROOT, src);
    assert.ok(fs.existsSync(file), `${src} is declared but not committed`);
    const head = fs.readFileSync(file).subarray(0, 4).toString('latin1');
    assert.equal(head, 'wOF2', `${src} is not a woff2 file`);
  }
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
