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

const BASE = process.argv[2] || process.env.VOCABX_URL || 'http://localhost:8000';

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

const VIEWS = ['home', 'learn', 'modules', 'test', 'ask', 'words', 'progress', 'profile', 'settings'];
/**
 * Views with no tab of their own. Each names the button that opens it, and the
 * element that proves it arrived — the level check in particular renders a
 * long band table and a plan list that only exist after a sitting.
 */
const DEEP_VIEWS = [
  { view: 'feedback', open: '#settingsFeedback', ready: '#fbManifest', from: 'settings' },
  { view: 'inbox', hash: '#inbox', ready: '#inboxToken' },
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
        const run = window.VocabX?.placement?.();
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

  /* The welcome asks the proxy whether accounts are possible and hides the
     two account buttons when they are not. That is right in the field and
     useless here — the form is a screen the sweep has to measure — so the
     answer is stubbed and only the answer. */
  await page.route('**/api/health', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, accounts: { rounds: 250000, tries: 8 } }),
  }));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  /* A fresh context has never chosen, so the first thing on screen is the
     welcome. Measured here, in the same loop as everything else, and then
     walked through as a person would — which is also the cheapest possible
     check that it is not a dead end at 320px. */
  await page.waitForSelector('#gate', { state: 'visible' });
  await page.waitForSelector('#gateNew:not([hidden])');
  await measure('welcome');
  await page.click('#gateNew');
  await page.waitForSelector('#gateFormEl', { state: 'visible' });
  await measure('welcome-form');
  await page.click('#gateBack');
  await page.waitForTimeout(120);
  await page.click('#gateGuest');
  await page.waitForSelector('#app', { state: 'visible' });
  await page.waitForTimeout(200);

  /* One unprompted note, put straight into the store so Home carries it at
     every size. It appears rarely by design, which is exactly why it would
     otherwise never be measured — and it is the widest thing on that screen:
     a long sentence, two buttons and a signature line that has to wrap
     rather than push the card sideways. */
  await page.evaluate(() => {
    const { Store, render } = window.VocabX;
    Store.commit((s) => {
      s.notices = [{
        id: 'sweep', at: Date.now(), day: new Date().toISOString().slice(0, 10),
        engine: 'Gemini', model: 'gemini-flash-lite-latest', kind: 'suggestion',
        text: 'You are at 85% correct over the week on a five-day streak, which is '
          + 'comfortable enough to take on a few more words each day.',
        action: 'set_daily_goal', args: { reviews: 30 }, state: 'open',
        saw: { streak: 5, accuracy7: 0.85, reviews7: 140, studied: 40 },
      }];
    });
    render();
  });
  await page.waitForTimeout(150);

  /* The rail starts closed, and choosing a view closes it again on a narrow
     screen — so the sweep opens it before each move rather than once. */
  const goto = async (tab) => {
    if (await page.evaluate(() => document.documentElement.classList.contains('rail-closed'))) {
      await page.click('#railToggle');
      await page.waitForTimeout(260);          // the slide
    }
    await page.click(`.tab[data-tab="${tab}"]`);
  };

  /** Nothing may reach past the right edge, on any screen, in any state. */
  async function measure(what) {
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => {
      const docWidth = document.documentElement.clientWidth;

      /* Past the right edge is only a fault if nothing above it clips the
         overhang. A layer drawn deliberately larger than its box and cut off
         by overflow:hidden cannot turn the page into a sideways scroller,
         which is the whole thing this looks for — and the welcome screen's
         background is three such layers. Where an ancestor does clip, the
         ancestor is measured on its own account anyway. */
      const escapes = (el) => {
        const right = el.getBoundingClientRect().right;
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== 'visible'
              && right > p.getBoundingClientRect().right + 1.5) return false;
        }
        return true;
      };

      const wide = [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > docWidth + 1.5)
        .filter(escapes)
        .map((el) => el.tagName.toLowerCase() + '.' + String(el.className.baseVal ?? el.className ?? '').split(' ')[0]);
      return {
        scrolls: document.documentElement.scrollWidth > docWidth + 1,
        culprits: [...new Set(wide)].slice(0, 4),
      };
    });
    if (overflow.scrolls || overflow.culprits.length) {
      problems.push(`${device.name}/${what}: overflows — ${overflow.culprits.join(', ') || 'document'}`);
    }
  }

  const stops = [
    ...VIEWS.map((view) => ({ view, tab: view })),
    ...DEEP_VIEWS,
  ];

  for (const { view, tab, open, ready, sit, from, hash } of stops) {
    if (tab) await goto(tab);
    else if (hash) {
      // The owner's inbox has no button anywhere; it is reached by typing.
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForSelector(ready, { state: 'visible' });
    } else {
      await goto(from || 'home');
      await page.waitForTimeout(120);
      await page.click(open);
      await page.waitForSelector(ready, { state: 'visible' });
      if (sit) await sitPlacement(page);
    }
    await measure(view);
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

  await goto('learn');
  await page.click('#revealBtn');
  await page.waitForTimeout(200);

  const icons = await page.evaluate(() => {
    /* Two different faults, and the width test only ever caught the first.
       An icon the layout squeezed to nothing is broken; an icon a media query
       deliberately took off the page (the header search below 550px) is not,
       so anything not being rendered at all is skipped. A <use> pointing at a
       symbol that moved paints nothing while still measuring 20px, which is
       why the href is resolved as well. */
    const shown = [...document.querySelectorAll('.ico')]
      .filter((i) => i.checkVisibility());
    const broken = [];
    for (const i of document.querySelectorAll('.ico use')) {
      const href = i.getAttribute('href') || '';
      if (!href.startsWith('#') || !document.querySelector(href)) broken.push(href || '(none)');
    }
    return {
      total: shown.length,
      dead: shown.filter((i) => i.getBoundingClientRect().width < 8).length,
      broken: [...new Set(broken)],
    };
  });
  if (icons.dead) problems.push(`${device.name}: ${icons.dead} of ${icons.total} icons did not paint`);
  if (icons.broken.length) {
    problems.push(`${device.name}: <use> points at nothing — ${icons.broken.join(', ')}`);
  }

  /* The card is revealed; grade it and check it stays. A graded card holds its
     place, shows where it is going, and moves on only when Next word is
     pressed — so the meaning is still readable, and the Undo bar below names
     the word that is actually on screen rather than the one after it. */
  const before = await page.textContent('#cardTerm');
  await page.click('#grades .btn--grade[data-grade="2"]');
  await page.waitForTimeout(200);
  const held = await page.evaluate(() => ({
    term: document.querySelector('#cardTerm').textContent,
    waiting: !document.querySelector('#cardDone').hidden,
    graded: document.querySelector('#grades').hidden,
    meaning: !document.querySelector('#cardBack').hidden,
    undo: document.querySelector('#undoWhat').textContent,
  }));
  if (held.term !== before) problems.push(`${device.name}: the card turned before Next word`);
  if (!held.waiting) problems.push(`${device.name}: no Next word after a grade`);
  if (!held.graded) problems.push(`${device.name}: the grade buttons stayed after grading`);
  if (!held.meaning) problems.push(`${device.name}: the meaning was hidden while the graded card waited`);
  if (held.undo !== before) problems.push(`${device.name}: Undo names ${held.undo}, the card shows ${before}`);
  await measure('learn-graded');
  await page.click('#nextWordBtn');
  await page.waitForTimeout(200);
  if (await page.evaluate(() => document.querySelector('#cardTerm').textContent) === before) {
    problems.push(`${device.name}: Next word did not advance`);
  }

  /* The assistant's sheet, holding an answer the length Gemini actually
     returns — the one panel that carries prose, and the one that would show a
     reply area too short to read in or a panel wider than the screen. */
  await page.click('#assistBtn');
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    const reply = document.querySelector('#assistReply');
    reply.hidden = false;
    reply.textContent = Array.from({ length: 16 }, (_, i) =>
      `Line ${i + 1}: an answer about the word, of the length one actually comes back.`).join('\n');
  });
  await measure('assist');
  const sheet = await page.evaluate(() => {
    const panel = document.querySelector('#assistSheet .sheet__panel');
    return {
      width: Math.round(panel.getBoundingClientRect().width),
      reply: Math.round(document.querySelector('#assistReply').getBoundingClientRect().height),
      ask: Math.round(document.querySelector('#assistSend').getBoundingClientRect().height),
      want: Math.min(680, window.innerWidth),
      /* On a screen too short to hold a long answer and the Ask box at once
         the reply sits on its floor and the panel scrolls, which is right.
         Only where there is room to spend is the roomier answer area owed. */
      owed: window.innerHeight >= 700 ? 220 : 100,
    };
  });
  if (Math.abs(sheet.width - sheet.want) > 2) {
    problems.push(`${device.name}: assist panel ${sheet.width}px, wanted ${sheet.want}px`);
  }
  if (sheet.reply < sheet.owed) {
    problems.push(`${device.name}: assist reply ${sheet.reply}px, wanted at least ${sheet.owed}px`);
  }
  if (sheet.ask < 30) problems.push(`${device.name}: the Ask box was squeezed off the assist sheet`);
  await page.click('#assistClose');

  await context.close();
}

await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n - ${problems.join('\n - ')}\n`);
  process.exit(1);
}
// +4: the welcome, its form, a graded card, and the assistant's sheet.
console.log(`clean across ${DEVICES.length} device shapes × ${VIEWS.length + DEEP_VIEWS.length + 4} views`);
