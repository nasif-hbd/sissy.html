#!/usr/bin/env node
/**
 * Device sweep — the check that catches what unit tests can't see.
 *
 *   npx playwright install chromium      # once
 *   python3 -m http.server 8000          # serve vocab/ in another terminal
 *   node tests/devices.mjs               # or: node tests/devices.mjs http://host:port
 *
 * Not part of `node --test` (it needs a browser). It drives every view at eight
 * viewport shapes and fails on the three faults that only appear at a size you
 * weren't looking at:
 *
 *   1. horizontal overflow — a grid column or a long word pushing past the
 *      viewport, which turns the whole page into a sideways scroller;
 *   2. tap targets under 30px on touch-sized screens;
 *   3. icons that don't paint, i.e. a <use> pointing at a symbol that moved.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || process.env.LEXIO_URL || 'http://localhost:8000';

const DEVICES = [
  { name: 'phone-se',    w: 320,  h: 568,  dsf: 2 },
  { name: 'phone',       w: 390,  h: 844,  dsf: 3 },
  { name: 'phone-max',   w: 430,  h: 932,  dsf: 3 },
  { name: 'phone-land',  w: 844,  h: 390,  dsf: 3 },
  { name: 'tablet',      w: 768,  h: 1024, dsf: 2 },
  { name: 'tablet-land', w: 1024, h: 768,  dsf: 2 },
  { name: 'laptop',      w: 1280, h: 800,  dsf: 1 },
  { name: 'desktop',     w: 1680, h: 1050, dsf: 1 },
];

const VIEWS = ['home', 'learn', 'modules', 'words', 'progress', 'settings'];
/**
 * Views with no tab of their own. Each names the button that opens it, and the
 * element that proves it arrived — the level check in particular renders a
 * long band table and a plan list that only exist after a sitting.
 */
const DEEP_VIEWS = [
  { view: 'assess', open: '#homeAssess', ready: '#assessIntro' },
  { view: 'assess-result', open: '#homeAssess', ready: '#assessIntro', sit: true },
];
const TOUCH_WIDTH = 900;   // below this the layout is finger-driven

/** Play a full level check so the result screen exists to be measured. */
async function sitPlacement(page) {
  await page.click('#assessStart');
  await page.waitForSelector('#assessExam', { state: 'visible', timeout: 20000 });
  for (let i = 0; i < 24; i += 1) {
    let info = null;
    for (let wait = 0; wait < 30 && !info; wait += 1) {
      info = await page.evaluate(() => {
        const run = window.Lexio?.placement?.();
        return run?.question ? { ans: run.question.answerIndex } : null;
      });
      if (!info) {
        if (await page.isVisible('#assessResult')) break;
        await page.waitForTimeout(120);
      }
    }
    if (!info) break;
    await page.evaluate((n) => document.querySelectorAll('#assessOptions .option')[n]?.click(), info.ans);
  }
  await page.waitForSelector('#assessResult', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(200);
}

const browser = await chromium.launch();
const problems = [];

for (const device of DEVICES) {
  const context = await browser.newContext({
    viewport: { width: device.w, height: device.h },
    deviceScaleFactor: device.dsf,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`${device.name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${device.name}: ${m.text()}`); });

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  const stops = [
    ...VIEWS.map((view) => ({ view, tab: view })),
    ...DEEP_VIEWS,
  ];

  for (const { view, tab, open, ready, sit } of stops) {
    if (tab) await page.click(`.tab[data-tab="${tab}"]`);
    else {
      await page.click('.tab[data-tab="home"]');
      await page.waitForTimeout(120);
      await page.click(open);
      await page.waitForSelector(ready, { state: 'visible' });
      if (sit) await sitPlacement(page);
    }
    await page.waitForTimeout(150);

    const overflow = await page.evaluate(() => {
      const docWidth = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > docWidth + 1.5)
        .map((el) => el.tagName.toLowerCase() + '.' + String(el.className.baseVal ?? el.className ?? '').split(' ')[0]);
      return {
        scrolls: document.documentElement.scrollWidth > docWidth + 1,
        culprits: [...new Set(wide)].slice(0, 4),
      };
    });
    if (overflow.scrolls || overflow.culprits.length) {
      problems.push(`${device.name}/${view}: overflows — ${overflow.culprits.join(', ') || 'document'}`);
    }
  }

  if (device.w < TOUCH_WIDTH) {
    const small = await page.evaluate(() => {
      const bad = [];
      // A checkbox's real target is the label wrapping it — measure that.
      for (const el of document.querySelectorAll('button:not([hidden]), .tab, input, select, label.check')) {
        if (el.type === 'checkbox' || el.hidden) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.height < 30) bad.push(`${el.id || el.className || el.tagName} ${Math.round(r.height)}px`);
      }
      return [...new Set(bad)].slice(0, 5);
    });
    if (small.length) problems.push(`${device.name}: tap targets too small — ${small.join(', ')}`);
  }

  await page.click('.tab[data-tab="learn"]');
  await page.click('#revealBtn');
  await page.waitForTimeout(200);

  const icons = await page.evaluate(() => {
    // SVGElement has no offsetParent, so decide visibility from the owning view.
    const shown = [...document.querySelectorAll('.ico')]
      .filter((i) => !i.closest('[hidden]') && !(i.closest('.view')?.hidden));
    return { total: shown.length, dead: shown.filter((i) => i.getBoundingClientRect().width < 8).length };
  });
  if (icons.dead) problems.push(`${device.name}: ${icons.dead} of ${icons.total} icons did not paint`);

  await context.close();
}

await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n - ${problems.join('\n - ')}\n`);
  process.exit(1);
}
console.log(`clean across ${DEVICES.length} device shapes × ${VIEWS.length + DEEP_VIEWS.length} views`);
