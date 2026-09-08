/**
 * The offline shell must list every module the app imports.
 *
 * A module missing from it still works online — the fetch handler caches it on
 * first use — so nothing fails in development, in the device sweep, or in any
 * other test. It fails on a cold launch with no network, on a phone, after the
 * app has been installed: the one place nobody is watching. It has happened
 * twice, which is twice more than a note in a comment was worth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const listed = new Set([...sw.matchAll(/'\.\/(js\/[\w/.-]+)'/g)].map((m) => m[1]));

test('every module in js/ is in the offline shell', () => {
  const onDisk = fs.readdirSync(path.join(ROOT, 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `js/${f}`);

  const missing = onDisk.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `not cached for offline: ${missing.join(', ')}`);
});

test('the shell does not list modules that no longer exist', () => {
  // The other direction: a rename leaves a 404 in the precache, and one
  // failed request rejects addAll — so the whole install silently does nothing.
  const gone = [...listed].filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert.deepEqual(gone, [], `listed but not on disk: ${gone.join(', ')}`);
});

test('every module index.html and the app import is on disk', () => {
  /* Catches the third shape of the same fault: an import added to a module
     whose file was never created, which fails at run time and nowhere else. */
  const files = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'));
  const missing = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
    for (const [, spec] of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = path.resolve(ROOT, 'js', spec);
      if (!fs.existsSync(target)) missing.push(`${file} -> ${spec}`);
    }
  }
  assert.deepEqual(missing, []);
});
