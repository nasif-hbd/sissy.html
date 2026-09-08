/**
 * Filenames the app ships.
 *
 * This exists because of a real bug that reached real downloads: two
 * dictionary shards were called `con.json` and `prn.json`. CON and PRN are
 * MS-DOS device names, still reserved on Windows forty years later, and a file
 * called `con.json` cannot be created in any folder on any Windows machine.
 *
 * What makes it worth a test rather than a fix is how it failed. Unzipping
 * reported two warnings in a dialog nobody reads, dropped the files, and
 * carried on. The app then had no words beginning "con" or "prn" — about 1,400
 * of them — with no error anywhere. It passed every test, because the tests
 * ran on Linux, where those names are perfectly ordinary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shardFile } from '../js/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every file that ships, by the same list scripts/package-web.sh copies. */
function shipped(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) shipped(full, out);
    else out.push(path.relative(root, full));
  }
  return out;
}

const PARTS = ['js', 'data', 'fonts', 'icons'];
const files = PARTS.flatMap((p) => shipped(path.join(root, p)));

test('no shipped file has a name Windows refuses to create', () => {
  // The device names, with or without an extension, in any folder.
  const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
  const bad = files.filter((f) => reserved.test(path.basename(f)));
  assert.deepEqual(bad, [],
    `these cannot be extracted on Windows and would vanish from the download: ${bad.join(', ')}`);
});

test('no shipped file has a character Windows refuses', () => {
  // < > : " | ? * are illegal in a Windows filename, and a trailing dot or
  // space is silently stripped, which turns into a file nobody can open.
  const illegal = /[<>:"|?*]/;
  const bad = files.filter((f) => illegal.test(path.basename(f))
    || /[. ]$/.test(path.basename(f)));
  assert.deepEqual(bad, [], `illegal on Windows: ${bad.join(', ')}`);
});

test('no two shipped files differ only by capitalisation', () => {
  // Windows and macOS treat these as the same file, so one silently replaces
  // the other on extraction and the app is missing whichever lost.
  const seen = new Map();
  const clashes = [];
  for (const f of files) {
    const key = f.toLowerCase();
    if (seen.has(key)) clashes.push(`${seen.get(key)} vs ${f}`);
    else seen.set(key, f);
  }
  assert.deepEqual(clashes, []);
});

test('a word in a renamed shard still resolves to a file that exists', () => {
  // The behaviour that broke: the key comes from the word, the filename comes
  // from the key, and when those two stopped agreeing the app returned "no
  // such word" for about 1,400 of them rather than an error anyone could see.
  const dir = path.join(root, 'data/dict');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));

  // The same derivation js/catalog.js uses to turn a word into a shard key.
  const prefix = (w, n) => w.slice(0, n).replace(/[^a-z]/g, '_').padEnd(n, '_');
  const keyFor = (w) => (index.deep.includes(prefix(w, 2)) ? prefix(w, 3) : prefix(w, 2));

  for (const word of ['concept', 'contrast', 'prnbogus', 'ability', 'zeal']) {
    const file = path.join(dir, `${shardFile(keyFor(word))}.json`);
    assert.ok(fs.existsSync(file),
      `"${word}" maps to ${path.basename(file)}, which is not on disk`);
  }

  // And the shard really holds the word, so the mapping is not merely pointing
  // at some file that happens to exist.
  const concept = JSON.parse(fs.readFileSync(
    path.join(dir, `${shardFile(keyFor('concept'))}.json`), 'utf8'));
  assert.ok(concept.concept, 'the shard for "concept" does not contain it');
});

test('every shard on disk is reachable by some key', () => {
  // The other half of the mapping. A rename that missed a file, or renamed one
  // the reader still asks for under its old name, leaves a shard nobody can
  // ever load — and the app treats an unreachable shard as "no such word".
  const dir = path.join(root, 'data/dict');
  const orphans = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => f.replace(/\.json$/, ''))
    .filter((name) => {
      const key = name.endsWith('-dict') ? name.slice(0, -'-dict'.length) : name;
      return shardFile(key) !== name;
    });
  assert.deepEqual(orphans, [], `no key maps to these files: ${orphans.join(', ')}`);
});

test('the reserved keys are the ones that actually got renamed', () => {
  // Pins the mapping itself, so a future rename cannot quietly break lookups
  // for words the app can still see listed in the index.
  assert.equal(shardFile('con'), 'con-dict');
  assert.equal(shardFile('prn'), 'prn-dict');
  assert.equal(shardFile('COM1'), 'COM1-dict');
  // And leaves every ordinary key alone.
  assert.equal(shardFile('ab'), 'ab');
  assert.equal(shardFile('con_'), 'con_');
  assert.equal(shardFile('cont'), 'cont');
});
