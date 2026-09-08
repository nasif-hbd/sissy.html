/**
 * Joining two histories of the same learner.
 *
 * This runs at exactly one moment — someone signs in on a device they have
 * already been studying on — and it is the moment where a fortnight of work
 * disappears if the rule is wrong. Nothing on screen would say so: the app
 * would look fine, with the wrong schedule in it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshots, hasWork } from '../js/sync.js';

const card = (over = {}) => ({ reps: 1, ease: 2.5, interval: 1, lapses: 0, due: 0, lastReviewed: 0, ...over });

test('a word met on either side was met', () => {
  const out = mergeSnapshots(
    { words: { a: { term: 'a' } }, srs: {}, days: {}, history: [] },
    { words: { b: { term: 'b' } }, srs: {}, days: {}, history: [] });
  assert.deepEqual(Object.keys(out.words).sort(), ['a', 'b']);
});

test('the card studied most recently wins', () => {
  const mine = { srs: { w: card({ lastReviewed: 200, interval: 1 }) }, words: {}, days: {}, history: [] };
  const theirs = { srs: { w: card({ lastReviewed: 100, interval: 60 }) }, words: {}, days: {}, history: [] };

  /* Not the one further ahead. A card with a 60-day interval from January is
     a card the learner has since forgotten and re-learnt; keeping it would
     stop the app showing a word they are currently getting wrong. */
  assert.equal(mergeSnapshots(mine, theirs).srs.w.interval, 1);
  assert.equal(mergeSnapshots(theirs, mine).srs.w.interval, 1, 'the answer changed with the argument order');
});

test('a card only one side has is kept', () => {
  const out = mergeSnapshots(
    { srs: { a: card() }, words: {}, days: {}, history: [] },
    { srs: { b: card() }, words: {}, days: {}, history: [] });
  assert.deepEqual(Object.keys(out.srs).sort(), ['a', 'b']);
});

test('a day is the larger of each count, never the sum', () => {
  const out = mergeSnapshots(
    { days: { '2026-09-01': { reviews: 10, correct: 8, seconds: 300 } }, words: {}, srs: {}, history: [] },
    { days: { '2026-09-01': { reviews: 6, correct: 5, seconds: 400 } }, words: {}, srs: {}, history: [] });

  /* Adding would be right once and wrong forever after: a device's own
     numbers come back to it on the next sync, and each round would inflate
     the day a little more. */
  assert.deepEqual(out.days['2026-09-01'], { reviews: 10, correct: 8, seconds: 400 });
});

test('merging twice changes nothing the second time', () => {
  const mine = {
    words: { a: {} }, srs: { a: card({ lastReviewed: 5 }) },
    days: { d: { reviews: 3 } }, history: [{ ts: 1, id: 'a' }],
    streak: { current: 2, longest: 9, lastActive: '2026-09-01' }, xp: { total: 40 },
  };
  const theirs = {
    words: { b: {} }, srs: { b: card({ lastReviewed: 7 }) },
    days: { d: { reviews: 5 } }, history: [{ ts: 2, id: 'b' }],
    streak: { current: 4, longest: 3, lastActive: '2026-09-03' }, xp: { total: 25 },
  };

  const once = mergeSnapshots(mine, theirs);
  // Every sync re-merges. A rule that drifts on each pass is a rule that is
  // quietly wrong by the end of the week.
  assert.deepEqual(mergeSnapshots(once, theirs), once);
  assert.deepEqual(mergeSnapshots(once, once), once);
});

test('both logs survive, in order, without doubling', () => {
  const shared = { ts: 100, id: 'w' };
  const out = mergeSnapshots(
    { history: [shared, { ts: 300, id: 'x' }], words: {}, srs: {}, days: {} },
    { history: [shared, { ts: 200, id: 'y' }], words: {}, srs: {}, days: {} });

  assert.deepEqual(out.history.map((h) => h.ts), [100, 200, 300]);
});

test('two words graded in the same millisecond are two reviews', () => {
  const out = mergeSnapshots(
    { history: [{ ts: 100, id: 'a' }], words: {}, srs: {}, days: {} },
    { history: [{ ts: 100, id: 'b' }], words: {}, srs: {}, days: {} });
  assert.equal(out.history.length, 2, 'deduplicated on time alone');
});

test('the longer streak and the later day both survive', () => {
  const out = mergeSnapshots(
    { streak: { current: 2, longest: 30, lastActive: '2026-08-01' }, words: {}, srs: {}, days: {}, history: [] },
    { streak: { current: 7, longest: 9, lastActive: '2026-09-04' }, words: {}, srs: {}, days: {}, history: [] });
  assert.equal(out.streak.longest, 30);
  assert.equal(out.streak.lastActive, '2026-09-04');
});

test('one side missing is the other side, not an empty app', () => {
  const mine = { words: { a: {} }, srs: {}, days: {}, history: [] };
  assert.deepEqual(mergeSnapshots(mine, null), mine);
  assert.deepEqual(mergeSnapshots(null, mine), mine);
  assert.deepEqual(mergeSnapshots(mine, undefined), mine);
});

test('a fresh install has no work to protect', () => {
  // What decides whether a merge is needed at all. The seed deck ships with
  // every install, so counting words would call every new phone "used".
  assert.equal(hasWork({ words: { a: {}, b: {} }, srs: {}, history: [] }), false);
  assert.equal(hasWork({ words: {}, srs: { a: card() }, history: [] }), true);
  assert.equal(hasWork({ words: {}, srs: {}, history: [{ ts: 1 }] }), true);
  assert.equal(hasWork(null), false);
});
