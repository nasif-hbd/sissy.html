/**
 * The four numbers on Home, and the table under them.
 *
 * Both are pure reads over the stored deck, and both have a quiet way of
 * lying: mastery divided by every word in the library reads 0% for months,
 * and a review log read forwards shows a word at its oldest sighting rather
 * than its newest. These are the checks for that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboard, recentlyLearned } from '../js/stats.js';

const DAY = 86_400_000;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A word in each SRS bucket, so the shares are countable by hand. */
function deck() {
  const soon = Date.now() + DAY;
  return {
    words: {
      one:   { id: 'one',   term: 'one',   definition: 'the first', level: 'A1' },
      two:   { id: 'two',   term: 'two',   definition: 'the second', level: 'A2' },
      three: { id: 'three', term: 'three', definition: 'the third', level: 'B1' },
      four:  { id: 'four',  term: 'four',  definition: '', level: '' },
    },
    srs: {
      // The record's own state decides the bucket, and past it the interval
      // separates mastered (21 days or more) from still-in-review.
      one:   { state: 'review',   due: soon, interval: 90, reps: 9, ease: 2.6, lapses: 0 },
      two:   { state: 'review',   due: soon, interval: 12, reps: 4, ease: 2.5, lapses: 0 },
      three: { state: 'learning', due: soon, interval: 0,  reps: 1, ease: 2.5, lapses: 0 },
      four:  { state: 'new',      due: 0,    interval: 0,  reps: 0, ease: 2.5, lapses: 0 },
    },
    days: { [today()]: { reviews: 12, correct: 10, learned: 3, seconds: 900 } },
    history: [
      { ts: 1, wordId: 'one' },
      { ts: 2, wordId: 'two' },
      { ts: 3, wordId: 'one' },      // seen twice — the newest one counts
      { ts: 4, wordId: 'gone' },     // deleted since
      { ts: 5, wordId: 'three' },
    ],
    streak: { current: 6, longest: 9, lastActive: today() },
  };
}

test('the tiles count what is learned, not what is in the library', () => {
  const d = dashboard(deck());
  assert.equal(d.words, 2, 'review + mastered, not every word on file');
  assert.equal(d.streak, 6);
  assert.equal(d.seconds, 900);
});

test('mastery is a share of what was started, not of the whole library', () => {
  // three started (mastered, review, learning); two of them are past learning.
  assert.equal(dashboard(deck()).mastery, 2 / 3);
});

test('mastery is null before anything is started, not zero', () => {
  const state = deck();
  for (const id of Object.keys(state.srs)) {
    state.srs[id] = { state: 'new', due: 0, interval: 0, reps: 0, ease: 2.5, lapses: 0 };
  }
  assert.equal(dashboard(state).mastery, null, '0% and "nothing yet" are different things');
});

test('a day with no session reports no time rather than throwing', () => {
  const state = deck();
  state.days = {};
  assert.equal(dashboard(state).seconds, 0);
});

test('the recent table shows each word once, at its newest sighting', () => {
  const rows = recentlyLearned(deck(), 6);
  assert.deepEqual(rows.map((r) => r.id), ['three', 'one', 'two'],
    'newest first, "one" at ts 3 rather than ts 1, and no duplicate');
});

test('a word deleted since it was reviewed is skipped, not rendered blank', () => {
  assert.ok(!recentlyLearned(deck(), 6).some((r) => r.id === 'gone'));
});

test('the recent table stops at the row count it was asked for', () => {
  assert.equal(recentlyLearned(deck(), 2).length, 2);
});

test('each recent row carries the state its label is drawn from', () => {
  const byId = Object.fromEntries(recentlyLearned(deck(), 6).map((r) => [r.id, r.state]));
  assert.equal(byId.one, 'mastered');
  assert.equal(byId.two, 'review');
  assert.equal(byId.three, 'learning');
});

test('an empty log makes an empty table rather than an error', () => {
  const state = deck();
  state.history = [];
  assert.deepEqual(recentlyLearned(state, 6), []);
});
