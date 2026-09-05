/**
 * A module that uses a name it never imported.
 *
 * This is the bug shape that hides best. Nothing fails to load, no test of
 * behaviour notices, the device sweep walks straight past it — because the
 * broken line is inside a function nobody calls until a learner ticks a box.
 * Push did exactly that: `proxyBase()` was used twice in notify.js and
 * imported nowhere, so turning on server push threw "proxyBase is not
 * defined" and showed that sentence to the learner as a toast.
 *
 * So: for every name any module exports, no other module may use it without
 * importing it. Names declared locally are the module's own and are left
 * alone — this is not a linter, it is a check on one specific accident.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'js');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
const source = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]));

/** Every name each module exports, by file. */
function exportsOf(code) {
  const names = new Set();
  for (const [, name] of code.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([\w$]+)/g)) names.add(name);
  for (const [, name] of code.matchAll(/export\s+(?:const|let|var)\s+([\w$]+)/g)) names.add(name);
  // export { a, b as c }
  for (const [, list] of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of list.split(',')) {
      const as = part.split(/\s+as\s+/);
      const name = (as[1] || as[0] || '').trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Every name each module imports, however it was spelled. */
function importsOf(code) {
  const names = new Set();
  for (const [, clause] of code.matchAll(/import\s+([^'"]+?)\s+from\s*['"][^'"]+['"]/g)) {
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const as = part.split(/\s+as\s+/);
        const name = (as[1] || as[0] || '').trim();
        if (name) names.add(name);
      }
    }
    // default and namespace imports
    const bare = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+/, '').split(',');
    for (const part of bare) { const name = part.trim(); if (name) names.add(name); }
  }
  return names;
}

/** Every identifier bound by a parameter list or a destructuring pattern. */
function bindingsIn(text) {
  const names = [];
  // `{ a, b: c, d = 1 }` binds a, c and d; the outer braces may be nested.
  for (const [, inner] of text.matchAll(/\{([^{}]*)\}/g)) {
    for (const part of inner.split(',')) {
      const name = part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[\w$]+$/.test(name)) names.push(name);
    }
  }
  for (const part of text.replace(/\{[^{}]*\}/g, '').split(',')) {
    const name = part.trim().split(/[\s=:.]/)[0].replace(/^\.\.\./, '');
    if (/^[\w$]+$/.test(name)) names.push(name);
  }
  return names;
}

/**
 * Names the file declares itself.
 *
 * Deliberately generous — a false "it declares this" only makes the check
 * quieter, while a false "it does not" would fail a build over a local
 * variable that happens to share a name with somebody's export. A destructured
 * parameter is the case that bit: `function localAssess({ estimate })` binds a
 * name placement.js also exports, and reading it as an import would have been
 * wrong twice over.
 */
function declaredIn(code) {
  const names = new Set();
  for (const [, name] of code.matchAll(/(?:const|let|var)\s+([\w$]+)/g)) names.add(name);
  for (const [, name] of code.matchAll(/(?:async\s+)?function\s*\*?\s*([\w$]+)/g)) names.add(name);
  for (const [, name] of code.matchAll(/class\s+([\w$]+)/g)) names.add(name);
  for (const [, list] of code.matchAll(/(?:const|let|var)\s*(\{[^{}]*\})\s*=/g)) {
    for (const name of bindingsIn(list)) names.add(name);
  }
  for (const [, list] of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const name of bindingsIn(list)) names.add(name);
  }
  for (const [, list] of code.matchAll(/function[^(]*\(([^()]*)\)/g)) {
    for (const name of bindingsIn(list)) names.add(name);
  }
  // `({ a }) => …` and `function f({ a }) {` — the pattern is its own group.
  for (const [, list] of code.matchAll(/\(\s*(\{[^{}]*\})[^)]*\)/g)) {
    for (const name of bindingsIn(list)) names.add(name);
  }
  return names;
}

/*
 * Names that belong to the browser before they belong to us.
 *
 * stats.js exports a function called `window`, which is why app.js imports it
 * as `windowStats`. Every other module's `window` is the global one, and no
 * import would ever be right for it.
 */
const GLOBALS = new Set(['window', 'document', 'location', 'navigator', 'screen',
  'history', 'name', 'origin', 'length', 'top', 'self', 'parent', 'status', 'close', 'open']);

/** The code, less strings and comments — where a match would mean nothing. */
function stripped(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

test('no module uses another module’s export without importing it', () => {
  const owners = new Map();          // exported name -> the file that exports it
  for (const file of files) for (const name of exportsOf(source[file])) {
    if (!owners.has(name)) owners.set(name, file);
  }

  const problems = [];
  for (const file of files) {
    const code = stripped(source[file]);
    const mine = exportsOf(source[file]);
    const brought = importsOf(source[file]);
    const local = declaredIn(code);

    for (const [name, from] of owners) {
      if (from === file || mine.has(name) || brought.has(name) || local.has(name)) continue;
      if (GLOBALS.has(name)) continue;
      /* Escaped, because a name is not a pattern: `$` and `$$` are the app's
         two query helpers and also regex anchors, so interpolating them raw
         matched the end of every line in every file. */
      const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Used as a bare identifier — not `foo.name`, not `{ name: … }`.
      const used = new RegExp(`(^|[^.\\w$])${safe}\\s*[(\\[.]`, 'm');
      if (used.test(code)) problems.push(`${file} uses ${name} (exported by ${from}) without importing it`);
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});
