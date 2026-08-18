/**
 * Scheduler + tracking tests.  Run with:  node --test vocab/tests/
 *
 * These cover the two things a vocabulary app must not get wrong: intervals
 * that grow the way the learner expects, and a streak that reflects real days.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { schedule, bucket, buildQueue, queueCounts, forecast, formatDelta } from '../js/srs.js';
import { makeSrs } from '../js/store.js';
import { summary, recentDays, masteryBreakdown, weakest } from '../js/stats.js';
import { dayKey, daysAgoKey } from '../js/store.js';

const DAY = 86_400_000;
const card = (over = {}) => ({ ...makeSrs(), ...over });

test('a new card walks the learning steps before graduating', () => {
  let r = card();
  r = schedule(r, 2);
  assert.equal(r.state, 'learning');
  assert.equal(r.step, 1);
  r = schedule(r, 2);
  assert.equal(r.state, 'review');
  assert.equal(r.interval, 1);
});

test('"easy" on a new card skips straight to review', () => {
  const r = schedule(card(), 3);
  assert.equal(r.state, 'review');
  assert.equal(r.interval, 4);
});

test('"again" on a new card resets to the first step', () => {
  let r = schedule(card(), 2);
  r = schedule(r, 0);
  assert.equal(r.state, 'learning');
  assert.equal(r.step, 0);
  assert.ok(r.due - Date.now() < 2 * 60_000);
});

test('review intervals grow, and grow faster for easy than for good', () => {
  const base = card({ state: 'review', interval: 10, ease: 2.5, reps: 5 });
  const good = schedule(base, 2);
  const easy = schedule(base, 3);
  const hard = schedule(base, 1);
  assert.ok(good.interval > base.interval, 'good must extend the interval');
  assert.ok(easy.interval > good.interval, 'easy must beat good');
  assert.ok(hard.interval < good.interval, 'hard must lag good');
});

test('a lapse drops ease, counts a lapse and sends the card back to learning', () => {
  const base = card({ state: 'review', interval: 30, ease: 2.5, reps: 9 });
  const lapsed = schedule(base, 0);
  assert.equal(lapsed.state, 'learning');
  assert.equal(lapsed.lapses, 1);
  assert.ok(lapsed.ease < base.ease);
  assert.ok(lapsed.interval < base.interval);
});

test('ease never falls below the floor, however often the card is failed', () => {
  let r = card({ state: 'review', interval: 5, ease: 1.4 });
  for (let i = 0; i < 20; i++) r = schedule({ ...r, state: 'review' }, 0);
  assert.ok(r.ease >= 1.3, `ease floor breached: ${r.ease}`);
});

test('intervals are capped', () => {
  let r = card({ state: 'review', interval: 300, ease: 3.0 });
  for (let i = 0; i < 10; i++) r = schedule(r, 3);
  assert.ok(r.interval <= 365);
});

test('buckets classify cards for the UI', () => {
  assert.equal(bucket(card()), 'new');
  assert.equal(bucket(card({ state: 'learning' })), 'learning');
  assert.equal(bucket(card({ state: 'review', interval: 5 })), 'review');
  assert.equal(bucket(card({ state: 'review', interval: 40 })), 'mastered');
  assert.equal(bucket(card({ state: 'review', interval: 40, lapses: 6 })), 'leech');
});

test('the queue puts overdue reviews first and honours the new-card allowance', () => {
  const now = Date.now();
  const state = {
    words: { a: { addedAt: 1 }, b: { addedAt: 2 }, c: { addedAt: 3 }, d: { addedAt: 4 } },
    srs: {
      a: card({ state: 'review', due: now - 5 * DAY, interval: 10 }),
      b: card({ state: 'review', due: now - 1 * DAY, interval: 10 }),
      c: card(),                                   // new
      d: card({ state: 'review', due: now + 3 * DAY }), // not due
    },
  };
  const queue = buildQueue(state, { now, newAllowance: 1 });
  assert.deepEqual(queue, ['a', 'b', 'c']);
  assert.equal(buildQueue(state, { now, newAllowance: 0 }).length, 2);

  const counts = queueCounts(state, now);
  assert.deepEqual(counts, { due: 2, learning: 0, new: 1 });

  const fc = forecast(state, 7, now);
  assert.equal(fc[3], 1, 'card d lands three days out');
});

test('formatDelta reads like a human wrote it', () => {
  assert.equal(formatDelta(60_000), '1m');
  assert.equal(formatDelta(3 * 3_600_000), '3h');
  assert.equal(formatDelta(2 * DAY), '2d');
  assert.equal(formatDelta(60 * DAY), '2mo');
});

// ── tracking ───────────────────────────────────────────────────────────────

function trackedState() {
  return {
    profile: { level: 'B1' },
    settings: { dailyGoal: 20 },
    words: {
      alpha: { id: 'alpha', term: 'alpha', addedAt: Date.now() },
      beta: { id: 'beta', term: 'beta', addedAt: Date.now() },
      gamma: { id: 'gamma', term: 'gamma', addedAt: Date.now() },
    },
    srs: {
      alpha: card({ state: 'review', interval: 30 }),
      beta: card({ state: 'review', interval: 3 }),
      gamma: card(),
    },
    days: {
      [dayKey()]: { reviews: 12, correct: 9, learned: 3, seconds: 300 },
      [daysAgoKey(1)]: { reviews: 20, correct: 18, learned: 5, seconds: 600 },
      [daysAgoKey(9)]: { reviews: 50, correct: 25, learned: 0, seconds: 900 },
    },
    history: [
      { wordId: 'beta', correct: false }, { wordId: 'beta', correct: false },
      { wordId: 'beta', correct: true }, { wordId: 'alpha', correct: true },
    ],
    streak: { current: 2, longest: 5, lastActive: dayKey() },
  };
}

test('summary reports only the last seven days', () => {
  const s = summary(trackedState());
  assert.equal(s.reviews7, 32, 'the 9-day-old session must not count');
  assert.equal(s.total, 3);
  assert.equal(s.known, 2, 'review + mastered cards are "known"');
  assert.equal(Math.round(s.accuracy7 * 100), 84);
  assert.equal(s.streak, 2);
});

test('mastery breakdown covers every card exactly once', () => {
  const m = masteryBreakdown(trackedState());
  assert.deepEqual(m, { new: 1, learning: 0, review: 1, mastered: 1, leech: 0 });
});

test('the weakest list surfaces the word being failed', () => {
  const [worst] = weakest(trackedState(), 3);
  assert.equal(worst.term, 'beta');
  assert.equal(worst.wrong, 2);
});

test('recentDays returns one entry per day, oldest first, ending today', () => {
  const days = recentDays(trackedState(), 14);
  assert.equal(days.length, 14);
  assert.equal(days.at(-1).key, dayKey());
  assert.equal(days.at(-1).reviews, 12);
  assert.equal(days.at(-2).reviews, 20);
});
