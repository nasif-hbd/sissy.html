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
import { dashboard, recentlyLearned, activeDays } from '../js/stats.js';

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

test('the tiles count what was met, not what is in the library', () => {
  const d = dashboard(deck());
  // three met (mastered, review, learning); the fourth is still untouched.
  assert.equal(d.words, 3, 'words studied, not every word on file');
  assert.equal(d.streak, 6);
  assert.equal(d.seconds, 900);
});

test('the learned count moves on the first card graded', () => {
  const state = deck();
  for (const id of Object.keys(state.srs)) {
    state.srs[id] = { state: 'new', due: 0, interval: 0, reps: 0, ease: 2.5, lapses: 0 };
  }
  assert.equal(dashboard(state).words, 0);

  // One card graded: it is in learning, days from graduating to review.
  state.srs.one = { state: 'learning', due: 1, interval: 0, reps: 1, ease: 2.5, lapses: 0 };
  assert.equal(dashboard(state).words, 1,
    'a tile that rewards turning up cannot sit at zero for two days');
  assert.equal(dashboard(state).mastery, 0, 'met is not mastered');
});

test('mastery is a share of what was started, not of the whole library', () => {
  // three started (mastered, review, learning); two of them are past learning.
  assert.equal(dashboard(deck()).mastery, 2 / 3);
  assert.equal(dashboard(deck()).words, 3, 'the same three the share is taken of');
});

test('every tile reads zero on a new install', () => {
  // The deck a new install is seeded with is words the learner was handed, not
  // words they have learned — nothing here may count them.
  const fresh = {
    words: deck().words,
    srs: Object.fromEntries(Object.keys(deck().words)
      .map((id) => [id, { state: 'new', due: 0, interval: 0, reps: 0, ease: 2.5, lapses: 0 }])),
    days: {},
    history: [],
    streak: { current: 0, longest: 0, lastActive: null },
  };
  assert.deepEqual(dashboard(fresh), { words: 0, mastery: 0, streak: 0, seconds: 0, days: 0 });
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

test('the day counter counts days studied, not days since the install', () => {
  const state = deck();
  state.days = {
    '2026-08-28': { reviews: 12, correct: 10, learned: 3, seconds: 600 },
    '2026-08-29': { reviews: 0,  correct: 0,  learned: 0, seconds: 0 },   // opened, did nothing
    '2026-08-31': { reviews: 4,  correct: 4,  learned: 1, seconds: 200 },
  };
  assert.equal(activeDays(state), 2, 'a day the app was merely opened is not a day studied');
  assert.equal(dashboard(state).days, 2);
});

test('a fortnight away moves the day counter by nothing', () => {
  const state = deck();
  const before = dashboard(state).days;
  state.createdAt = Date.now() - 400 * 86_400_000;   // installed over a year ago
  assert.equal(dashboard(state).days, before, 'the calendar is not progress');
});
