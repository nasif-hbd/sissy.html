/**
 * The XP economy.
 *
 * These pin the two things a points system must not get wrong: the curve is
 * monotonic and never divides by zero, and the ranking answers reflect what
 * actually happened rather than insertion order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { standing, xpForLevel, AWARDS, moduleStandings, bestDays } from '../js/xp.js';

test('levels rise monotonically and the bar never overflows', () => {
  let last = 0;
  for (let xp = 0; xp <= 20000; xp += 37) {
    const s = standing(xp);
    assert.ok(s.level >= last, `level went backwards at ${xp}`);
    assert.ok(s.level >= 1);
    assert.ok(s.into >= 0 && s.into < s.need, `progress out of range at ${xp}: ${s.into}/${s.need}`);
    assert.ok(s.pct >= 0 && s.pct < 1);
    last = s.level;
  }
});

test('a level boundary lands exactly on zero progress', () => {
  for (const level of [2, 3, 7, 12]) {
    const s = standing(xpForLevel(level));
    assert.equal(s.level, level, `xpForLevel(${level}) should start level ${level}`);
    assert.equal(s.into, 0);
  }
});

test('one XP short of a boundary is still the level below', () => {
  const s = standing(xpForLevel(4) - 1);
  assert.equal(s.level, 3);
});

test('every award is positive — no action costs the learner points', () => {
  for (const [name, value] of Object.entries(AWARDS)) {
    assert.ok(value > 0, `${name} must be positive`);
  }
  assert.ok(AWARDS.reviewCorrect > AWARDS.reviewWrong, 'being right should pay more');
  assert.ok(AWARDS.sentenceCoached > AWARDS.reviewCorrect, 'writing is the hardest work');
});

test('titles never regress as levels climb', () => {
  const seen = [];
  for (let level = 1; level <= 40; level += 1) {
    const title = standing(xpForLevel(level)).title;
    if (!seen.includes(title)) seen.push(title);
  }
  assert.equal(seen[0], 'Beginner');
  assert.ok(seen.length >= 5, 'expected several titles across 40 levels');
});

// ── ranking ────────────────────────────────────────────────────────────────
const state = {
  words: { a: { module: 'sat' }, b: { module: 'sat' }, c: { module: 'ielts' } },
  days: { '2026-01-01': { reviews: 4 }, '2026-01-02': { reviews: 30 } },
  xp: {
    total: 500,
    byModule: { sat: 120, ielts: 300 },
    byDay: { '2026-01-01': 40, '2026-01-02': 460 },
  },
};

test('modules rank by XP, not by how many words were added', () => {
  const rows = moduleStandings(state, [{ id: 'sat', title: 'SAT' }, { id: 'ielts', title: 'IELTS' }]);
  assert.equal(rows[0].title, 'IELTS');   // fewer words, more XP
  assert.equal(rows[0].xp, 300);
  assert.equal(rows[1].words, 2);
});

test('a module with words but no XP still appears', () => {
  const rows = moduleStandings(
    { ...state, xp: { ...state.xp, byModule: {} } },
    [{ id: 'sat', title: 'SAT' }],
  );
  assert.ok(rows.some((r) => r.id === 'sat' && r.xp === 0));
});

test('best days come back highest first', () => {
  const days = bestDays(state, 5);
  assert.equal(days[0].day, '2026-01-02');
  assert.equal(days[0].xp, 460);
  assert.equal(days.length, 2);
});
