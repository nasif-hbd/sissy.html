import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, restore } from '../js/store.js';

/*
 * Grading writes to six places. Undo copies four of them and puts them back,
 * rather than reversing each write — the streak in particular cannot be
 * recomputed from what survives, so an arithmetic undo would quietly lose it.
 */
const deck = () => ({
  srs: { hello: { state: 'review', due: 100, interval: 5, ease: 2.5, lapses: 0 } },
  days: { '2026-08-29': { reviews: 7, correct: 6, learned: 2 } },
  streak: { current: 9, best: 12, lastDay: '2026-08-29' },
  xp: { total: 940, byDay: { '2026-08-29': 120 } },
  history: [{ ts: 1, wordId: 'hello' }, { ts: 2, wordId: 'world' }],
});

test('a snapshot survives the grade it was taken before', () => {
  const state = deck();
  const shot = snapshot(state, 'hello', '2026-08-29');

  // grade it: schedule moves, counters rise, XP is paid, the log grows
  state.srs.hello = { state: 'review', due: 999999, interval: 40, ease: 2.65, lapses: 0 };
  state.days['2026-08-29'] = { reviews: 8, correct: 7, learned: 2 };
  state.streak = { current: 10, best: 12, lastDay: '2026-08-29' };
  state.xp = { total: 970, byDay: { '2026-08-29': 150 } };
  state.history.push({ ts: 3, wordId: 'hello', grade: 3 });

  restore(state, shot);
  assert.deepEqual(state, deck(), 'every part of the deck is back where it was');
});

test('the copy is deep, so the deck cannot be mutated through it', () => {
  const state = deck();
  const shot = snapshot(state, 'hello', '2026-08-29');
  state.srs.hello.interval = 40;
  state.days['2026-08-29'].reviews = 99;
  state.streak.current = 0;
  restore(state, shot);
  assert.equal(state.srs.hello.interval, 5);
  assert.equal(state.days['2026-08-29'].reviews, 7);
  assert.equal(state.streak.current, 9);
});

test('undoing the first review of a brand-new day removes the day again', () => {
  // Otherwise an undone-to-empty day still counts towards the streak.
  const state = { ...deck(), days: {}, history: [] };
  const shot = snapshot(state, 'hello', '2026-08-30');
  state.days['2026-08-30'] = { reviews: 1, correct: 1, learned: 0 };
  state.history.push({ ts: 4, wordId: 'hello' });
  restore(state, shot);
  assert.equal('2026-08-30' in state.days, false);
  assert.equal(state.history.length, 0);
});

test('undoing the very first review of a word removes its schedule', () => {
  const state = { srs: {}, days: {}, streak: { current: 0 }, xp: {}, history: [] };
  const shot = snapshot(state, 'fresh', '2026-08-29');
  state.srs.fresh = { state: 'learning', due: 60000, step: 0, ease: 2.5 };
  restore(state, shot);
  assert.equal('fresh' in state.srs, false, 'a card that had no schedule gets none back');
});

test('only the log written after the snapshot is dropped', () => {
  const state = deck();
  const shot = snapshot(state, 'hello', '2026-08-29');
  state.history.push({ ts: 3 }, { ts: 4 });
  restore(state, shot);
  assert.equal(state.history.length, 2);
  assert.deepEqual(state.history.map((h) => h.ts), [1, 2]);
});

test('restoring nothing is a no-op, not a crash', () => {
  const state = deck();
  assert.deepEqual(restore(state, null), deck());
});
