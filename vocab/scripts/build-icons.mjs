#!/usr/bin/env node
/**
 * Cut the app's icons out of the source logo.
 *
 *   node scripts/build-icons.mjs [brand/vocabx.png]
 *
 * The logo is a square lockup: the book-and-X mark, the word "VocabX" under
 * it, and a tagline under that. At 32 pixels in a browser tab the wordmark and
 * tagline are mud, so the small icons are cut down to the mark alone and
 * recomposed on the logo's own ground. The whole lockup is kept for the one
 * place it is shown large.
 *
 * There is no ImageMagick on the machines this runs on, and adding a native
 * image dependency to a build that has none was not worth it — Chromium is
 * already here for the device sweep, and a canvas resamples correctly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

/* The source lives outside icons/ because everything in icons/ is served and
   packaged, and a megabyte of artwork nothing requests has no business there. */
const args = process.argv.slice(2);
/* The desktop downloads need the same mark at the sizes macOS and Linux ask
   for. Same source, same crop, same ground — an app whose Dock icon does not
   match its favicon looks like two different programs. */
const DESKTOP = args.includes('--desktop');
const SRC = args.find((a) => !a.startsWith('--')) || 'brand/vocabx.png';
const OUT = DESKTOP ? 'desktop/icon' : 'icons';

/** How much of an icon the mark should fill. Maskable icons are cropped to a
 *  circle by some launchers, and 80% is the safe zone every platform agrees on. */
const FILL = 0.74;

/*
 * WebP everywhere it is allowed, because this logo is a smooth gradient render
 * and PNG has nothing to gain from: the 512 is 265 KB as a PNG and 12 KB as
 * WebP, and the app's whole first load is 133 KB. PNG stays for the two places
 * with a reason — the iOS home-screen icon, and a favicon fallback.
 */
const jobs = DESKTOP ? [
  // The set macOS packs into an .icns, and Linux hangs in its launcher.
  1024, 512, 256, 128, 64, 32, 16,
].map((size) => ({ name: `icon-${size}.png`, size, type: 'image/png' })) : [
  { name: 'mark-512.webp', size: 512, type: 'image/webp', q: 0.9 },
  { name: 'mark-192.webp', size: 192, type: 'image/webp', q: 0.9 },
  { name: 'mark-64.webp', size: 64, type: 'image/webp', q: 0.92 },
  { name: 'mark-180.png', size: 180, type: 'image/png' },   // apple-touch-icon
  { name: 'mark-32.png', size: 32, type: 'image/png' },     // favicon fallback
];
/** The whole lockup, at the one size it is shown large. */
const LOCKUP = { name: 'lockup-400.webp', size: 400, type: 'image/webp', q: 0.9, mode: 'lockup' };

const browser = await chromium.launch();
const page = await browser.newPage();
const uri = `data:image/png;base64,${fs.readFileSync(SRC).toString('base64')}`;

const result = await page.evaluate(async ({ uri, jobs, lockup, fill }) => {
  const img = new Image();
  img.src = uri;
  await img.decode();

  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  const sg = src.getContext('2d', { willReadFrequently: true });
  sg.drawImage(img, 0, 0);
  const { data } = sg.getImageData(0, 0, src.width, src.height);
  const lit = (x, y) => {
    const i = (y * src.width + x) * 4;
    return data[i] + data[i + 1] + data[i + 2] > 150;
  };

  /* Find the mark without hard-coding where it is: measure ink per row, take
     the widest empty band below the artwork as the split, and everything above
     it is the mark. A re-exported logo with different margins still works. */
  const rows = [];
  for (let y = 0; y < src.height; y++) {
    let n = 0, minX = 1e9, maxX = -1;
    for (let x = 0; x < src.width; x++) if (lit(x, y)) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; }
    rows.push([n, minX, maxX]);
  }
  let split = src.height, best = 0, run = null;
  for (let y = 0; y < rows.length; y++) {
    if (rows[y][0] <= 2) { run = run || { from: y }; run.to = y; }
    else if (run) {
      const h = run.to - run.from;
      if (run.from > src.height * 0.25 && h > best) { best = h; split = run.from; }
      run = null;
    }
  }
  const mark = { minX: 1e9, maxX: -1, minY: 1e9, maxY: -1 };
  for (let y = 0; y < split; y++) {
    const [n, a, z] = rows[y];
    if (!n) continue;
    if (y < mark.minY) mark.minY = y;
    mark.maxY = y;
    if (a < mark.minX) mark.minX = a;
    if (z > mark.maxX) mark.maxX = z;
  }
  const markW = mark.maxX - mark.minX + 1;
  const markH = mark.maxY - mark.minY + 1;

  // The ground, taken from a corner so the icon sits on the logo's own black.
  const corner = sg.getImageData(4, 4, 1, 1).data;
  const ground = `rgb(${corner[0]},${corner[1]},${corner[2]})`;

  const draw = (size, mode, type, q) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    if (mode === 'lockup') {
      g.drawImage(img, 0, 0, size, size);
    } else {
      g.fillStyle = ground;
      g.fillRect(0, 0, size, size);
      const scale = (size * fill) / Math.max(markW, markH);
      const w = markW * scale, h = markH * scale;
      g.drawImage(img, mark.minX, mark.minY, markW, markH,
        (size - w) / 2, (size - h) / 2, w, h);
    }
    return c.toDataURL(type, q);
  };

  return {
    split, mark, ground,
    files: (lockup ? [...jobs, lockup] : jobs)
      .map((j) => ({ ...j, uri: draw(j.size, j.mode || 'mark', j.type, j.q) })),
  };
}, { uri, jobs, lockup: DESKTOP ? null : LOCKUP, fill: FILL });

await browser.close();

fs.mkdirSync(OUT, { recursive: true });
console.log(`source ${SRC}`);
console.log(`  mark found at x ${result.mark.minX}–${result.mark.maxX}, y ${result.mark.minY}–${result.mark.maxY}`);
console.log(`  wordmark starts at y ${result.split}; ground ${result.ground}\n`);
for (const f of result.files) {
  const bytes = Buffer.from(f.uri.split(',')[1], 'base64');
  fs.writeFileSync(path.join(OUT, f.name), bytes);
  const got = f.uri.slice(5, f.uri.indexOf(';'));
  if (got !== f.type) throw new Error(`${f.name}: this browser produced ${got}, not ${f.type}`);
  console.log(`  ${f.name.padEnd(17)} ${String(f.size).padStart(4)}px  ${(bytes.length / 1024).toFixed(1).padStart(7)} KB`);
}
