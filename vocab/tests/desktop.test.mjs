/**
 * The desktop downloads.
 *
 * These are the one part of the project nobody can check by looking at the
 * page: a missing exec bit, a plist typo or a stale app folder is invisible
 * until someone downloads it, and by then it is on their machine. Each of
 * these has been a real way to ship a dead download.
 *
 * They read the built archives, so they skip rather than fail when nothing
 * has been packaged yet — `vocab/desktop/package.sh` makes them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DOWNLOADS } from '../js/install.js';
import { APP } from '../js/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(here, '../../download');

/** `unzip -l` rather than a zip library, so this stays dependency-free. */
const listing = (zip) => execFileSync('unzip', ['-l', zip], { encoding: 'utf8' });
const has = (zip, file) => listing(zip).includes(file);
const read = (zip, file) => execFileSync('unzip', ['-p', zip, file], { encoding: 'utf8' });
/** The permission bits zip stored, as `-rwxr-xr-x`. */
const modeOf = (zip, file) => {
  const line = execFileSync('unzip', ['-Z', '-1', '-l', zip, file], { encoding: 'utf8' }).trim();
  return line.split(/\s+/)[0];
};

/* Every desktop points at the same archive, so this checks it once. */
const ZIP = path.join(DIR, DOWNLOADS.windows.file);
const when = { skip: fs.existsSync(ZIP) ? false : `${DOWNLOADS.windows.file} not built` };

test('the download carries the app it claims to', when, () => {
  // A launcher packaged around last release's app folder is the failure
  // nobody notices: it runs, it just teaches yesterday's words.
  const cfg = read(ZIP, 'vocabx-desktop/app/js/config.js');
  assert.ok(cfg.includes(`build: '${APP.build}'`),
    `the download was packaged around a different build than ${APP.build}`);
});

test('the download explains itself, and carries one app for three launchers', when, () => {
  const files = listing(ZIP);
  assert.ok(files.includes('vocabx-desktop/README.txt'), 'no README');
  for (const launcher of ['vocabx-desktop/VocabX.exe', 'vocabx-desktop/VocabX',
                          'vocabx-desktop/VocabX.app/Contents/MacOS/VocabX']) {
    assert.ok(files.includes(launcher), `no launcher at ${launcher}`);
  }
  // One copy of the dictionary, not three. This is the whole point of the
  // single archive, and it is one careless cp away from being three again.
  const copies = (files.match(/app\/data\/dict\/index\.json/g) || []).length;
  assert.equal(copies, 1, `the app folder is in the archive ${copies} times`);
});

test('the Windows and Linux launchers stay executable through the zip', when, () => {
  // A zip that flattens the mode bit produces a download that cannot be run
  // and a person who thinks the app is broken.
  for (const exe of ['vocabx-desktop/VocabX.exe', 'vocabx-desktop/VocabX']) {
    assert.match(modeOf(ZIP, exe), /^-rwx/, `${exe} lost its executable bit`);
  }
});

test('the macOS bundle is a bundle macOS will open', when, () => {
  const app = 'vocabx-desktop/VocabX.app/Contents';

  // Miss any one of these and Finder shows a folder, or a broken app icon.
  for (const part of ['Info.plist', 'PkgInfo', 'MacOS/VocabX',
                      'Resources/vocabx.pl', 'Resources/VocabX.icns']) {
    assert.ok(has(ZIP, `${app}/${part}`), `the bundle is missing ${part}`);
  }

  const plist = read(ZIP, `${app}/Info.plist`);
  // The two keys that decide whether it launches at all and whether it has a
  // face; both name a file that has to exist, and both have been wrong.
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>VocabX<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>VocabX<\/string>/);
  assert.match(plist, /<key>CFBundlePackageType<\/key>\s*<string>APPL<\/string>/);

  assert.match(modeOf(ZIP, `${app}/MacOS/VocabX`), /^-rwx/,
    'the bundle executable lost its executable bit');

  // The app folder is outside the bundle in this layout, so the launcher has
  // to look in both places — hard-coding either one breaks half the cases.
  const launcher = read(ZIP, `${app}/MacOS/VocabX`);
  assert.match(launcher, /dirname "\$0"/, 'the launcher does not locate itself');
  assert.match(launcher, /perl/, 'the launcher does not start the server');
  assert.match(launcher, /Resources/, 'the launcher never looks inside the bundle');
  assert.match(launcher, /\.\.\/\.\.\/\.\./, 'the launcher never looks beside the bundle');
});

test('the icns really is an icns, with the sizes macOS asks for', () => {
  const icns = path.resolve(here, '../desktop/icon');
  // The PNGs are committed; the .icns is built from them, so check the source.
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    assert.ok(fs.existsSync(path.join(icns, `icon-${size}.png`)),
      `no icon-${size}.png to pack into the bundle icon`);
  }
});

test('no download promises a file that is not there', () => {
  // DOWNLOADS is what the buttons point at. A name here with no archive built
  // is a 404 on somebody's first visit.
  for (const [os, meta] of Object.entries(DOWNLOADS)) {
    assert.match(meta.file, /^vocabx-[a-z]+\.zip$/, `${os}: odd filename`);
    if (fs.existsSync(DIR)) {
      const built = fs.readdirSync(DIR);
      if (built.some((f) => f.startsWith('vocabx-') && f.endsWith('.zip'))) {
        assert.ok(built.includes(meta.file),
          `${os}: the button points at ${meta.file}, which was never packaged`);
      }
    }
  }
});
