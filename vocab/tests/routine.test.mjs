/**
 * The routine — the schedule behind the notifications.
 *
 * A reminder that fires twice, at the wrong hour, or silently never is the kind
 * of bug nobody reports and everybody resents. These pin the firing rules, the
 * migration from the old flat list of times, and the copy for each step type.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS, DEFAULT_ROUTINE, validTime, minutesOf, makeStep, fromTimes,
  sortRoutine, dueStep, cardFor, quoteFor, QUOTES,
} from '../js/routine.js';

const at = (h, m = 0) => { const d = new Date(2026, 0, 15, h, m, 0); return d; };
const step = (id, time, action = 'review') => ({ id, time, action });

// ── time parsing ───────────────────────────────────────────────────────────

test('only real 24-hour times are accepted', () => {
  for (const good of ['00:00', '09:05', '13:30', '23:59']) {
    assert.ok(validTime(good), `${good} should be valid`);
  }
  for (const bad of ['24:00', '9:05', '12:60', '', null, undefined, '1230', 'noon', '-1:00']) {
    assert.ok(!validTime(bad), `${JSON.stringify(bad)} should be rejected`);
  }
});

test('minutes are counted from midnight, and nonsense returns null', () => {
  assert.equal(minutesOf('00:00'), 0);
  assert.equal(minutesOf('08:30'), 510);
  assert.equal(minutesOf('23:59'), 1439);
  assert.equal(minutesOf('nope'), null);
});

// ── firing rules ───────────────────────────────────────────────────────────

test('a step fires once its time has passed, not before', () => {
  const routine = [step('a', '09:00')];
  assert.equal(dueStep(routine, { now: at(8, 59), today: 'D' }), null, 'fired a minute early');
  assert.equal(dueStep(routine, { now: at(9, 0), today: 'D' })?.id, 'a');
  assert.equal(dueStep(routine, { now: at(9, 29), today: 'D' })?.id, 'a');
});

test('a step long past its time is skipped rather than fired stale', () => {
  // Closing the laptop all afternoon must not produce a burst at six o'clock.
  const routine = [step('a', '09:00')];
  assert.equal(dueStep(routine, { now: at(9, 31), today: 'D' }), null);
  assert.equal(dueStep(routine, { now: at(18, 0), today: 'D' }), null);
});

test('a step already fired today does not fire again', () => {
  const routine = [step('a', '09:00')];
  const fired = { a: '2026-01-15' };
  assert.equal(dueStep(routine, { now: at(9, 10), today: '2026-01-15', fired }), null);
  // …but it comes back the next day.
  assert.equal(dueStep(routine, { now: at(9, 10), today: '2026-01-16', fired })?.id, 'a');
});

test('after a gap the most recent step wins, not the oldest', () => {
  const routine = [step('morning', '09:00'), step('noon', '12:00'), step('tea', '15:00')];
  const due = dueStep(routine, { now: at(15, 5), today: 'D', graceMins: 600 });
  assert.equal(due.id, 'tea', 'should offer the latest passed step');
});

test('a step keyed by id survives having its time edited', () => {
  // The fired-today record keys on id, so moving 09:00 to 09:30 must not
  // re-fire the same step the same morning.
  const fired = { a: 'D' };
  assert.equal(dueStep([step('a', '09:30')], { now: at(9, 35), today: 'D', fired }), null);
});

test('an invalid time in the routine is ignored, not crashed on', () => {
  const routine = [{ id: 'bad', time: '25:99', action: 'review' }, step('ok', '09:00')];
  assert.equal(dueStep(routine, { now: at(9, 5), today: 'D' })?.id, 'ok');
});

test('an empty or missing routine simply has nothing due', () => {
  assert.equal(dueStep([], { now: at(9, 0), today: 'D' }), null);
  assert.equal(dueStep(undefined, { now: at(9, 0), today: 'D' }), null);
});

// ── migration ──────────────────────────────────────────────────────────────

test('old reminder times become routine steps, in order', () => {
  const routine = fromTimes(['20:00', '09:00']);
  assert.deepEqual(routine.map((s) => s.time), ['09:00', '20:00'], 'should be sorted by time');
  assert.ok(routine.every((s) => s.id && ACTIONS[s.action]));
});

test('migration keeps every valid time and drops the rest', () => {
  const routine = fromTimes(['09:00', 'garbage', '', '21:30']);
  assert.deepEqual(routine.map((s) => s.time), ['09:00', '21:30']);
});

test('a migrated morning slot is a word card, a later one a review', () => {
  const [morning] = fromTimes(['07:30']);
  const [evening] = fromTimes(['20:00']);
  assert.equal(morning.action, 'word');
  assert.equal(evening.action, 'review');
});

test('every step the app can build names a real action', () => {
  assert.ok(ACTIONS[makeStep().action]);
  assert.ok(ACTIONS[makeStep('09:00', 'quote').action]);
  assert.equal(makeStep('09:00', 'nonsense').action, 'review', 'unknown action falls back');
  for (const s of DEFAULT_ROUTINE) assert.ok(ACTIONS[s.action], `${s.action} is not an action`);
});

test('new steps get distinct ids', () => {
  const ids = new Set(Array.from({ length: 50 }, () => makeStep().id));
  assert.equal(ids.size, 50);
});

test('sorting a routine does not mutate the original', () => {
  const routine = [step('b', '20:00'), step('a', '09:00')];
  const sorted = sortRoutine(routine);
  assert.equal(routine[0].id, 'b', 'the input was reordered in place');
  assert.equal(sorted[0].id, 'a');
});

// ── the cards ──────────────────────────────────────────────────────────────

test('a word card shows the word and its meaning', () => {
  const card = cardFor(step('a', '08:00', 'word'), {
    word: { term: 'resilient', pos: 'adjective', definition: 'able to recover quickly' },
  });
  assert.equal(card.title, 'resilient');
  assert.match(card.body, /adjective/);
  assert.match(card.body, /able to recover quickly/);
  assert.ok(card.quiet, 'a lock-screen card should not carry action buttons');
});

test('a word card with no word to show produces nothing at all', () => {
  // Better silent than a notification reading "undefined".
  assert.equal(cardFor(step('a', '08:00', 'word'), {}), null);
  assert.equal(cardFor(step('a', '08:00', 'word'), { word: {} }), null);
});

test('a quote card carries the line, and nothing without one', () => {
  const card = cardFor(step('a', '08:00', 'quote'), { quote: 'Keep going.' });
  assert.equal(card.body, 'Keep going.');
  assert.ok(card.quiet);
  assert.equal(cardFor(step('a', '08:00', 'quote'), {}), null);
});

test('a review card counts due and learning together', () => {
  const card = cardFor(step('a', '13:00', 'review'), { due: 4, learning: 3, doneToday: 2 });
  assert.match(card.title, /7 words/);
  assert.match(card.body, /2 done today/);
  assert.equal(card.view, 'learn');
});

test('a review card says "word" in the singular for one', () => {
  assert.match(cardFor(step('a', '13:00'), { due: 1 }).title, /1 word ready/);
});

test('nothing due and the goal met is not worth interrupting for', () => {
  assert.equal(cardFor(step('a', '13:00'), { due: 0, learning: 0, fresh: 0, doneToday: 20, dailyGoal: 20 }), null);
});

test('nothing due but new words waiting says so', () => {
  const card = cardFor(step('a', '13:00'), { due: 0, fresh: 5, dailyGoal: 20 });
  assert.match(card.title, /5 new words/);
});

test('a module card names the module and the set', () => {
  const card = cardFor(step('a', '21:00', 'module'), { moduleTitle: 'IELTS', setNumber: 4 });
  assert.match(card.title, /IELTS — set 4/);
  assert.equal(card.view, 'modules');
});

test('a module card with nothing started invites picking one', () => {
  const card = cardFor(step('a', '21:00', 'module'), {});
  assert.match(card.title, /Pick a module/);
  assert.equal(card.view, 'modules');
});

test('every card routes to a view the app actually has', () => {
  const views = new Set(['home', 'learn', 'practice', 'modules', 'words', 'progress', 'settings', 'ask']);
  const ctx = { due: 3, moduleTitle: 'IELTS', setNumber: 2, quote: 'x',
                word: { term: 'w', definition: 'd' }, dailyGoal: 20 };
  for (const action of Object.keys(ACTIONS)) {
    const card = cardFor(step('a', '09:00', action), ctx);
    assert.ok(card, `${action} produced no card`);
    assert.ok(views.has(card.view), `${action} routes to unknown view "${card.view}"`);
    assert.ok(card.title && card.body, `${action} is missing title or body`);
  }
});

test('every action declares a view matching what its card routes to', () => {
  const ctx = { due: 3, moduleTitle: 'IELTS', setNumber: 2, quote: 'x',
                word: { term: 'w', definition: 'd' }, dailyGoal: 20 };
  for (const [name, meta] of Object.entries(ACTIONS)) {
    assert.equal(cardFor(step('a', '09:00', name), ctx).view, meta.view,
      `${name}: ACTIONS says ${meta.view}`);
  }
});

// ── quotes ─────────────────────────────────────────────────────────────────

test('the quote of the day is stable for a day and moves between days', () => {
  assert.equal(quoteFor('2026-01-15'), quoteFor('2026-01-15'), 'same day gave two lines');
  const week = new Set(['15', '16', '17', '18', '19', '20', '21'].map((d) => quoteFor(`2026-01-${d}`)));
  assert.ok(week.size > 1, 'a whole week returned the same line');
});

test('every quote is a real, short line', () => {
  for (const q of QUOTES) {
    assert.ok(q.length > 20 && q.length < 120, `bad length: ${q}`);
    assert.match(q, /[.!?]$/, `no end punctuation: ${q}`);
  }
});

test('an empty quote list returns nothing rather than crashing', () => {
  assert.equal(quoteFor('2026-01-15', []), '');
});
