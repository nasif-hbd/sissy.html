/**
 * The suggestion engine.
 *
 * A recommendation nobody can check is just a confident sentence. These pin the
 * direction of every rule: struggling learners are never told to speed up, the
 * module ranking prefers a stretch over revision, and applying the plan reports
 * only what it would really change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pace, rankModules, buildPlan, cefrIndex } from '../js/advice.js';

const at = (level, index) => ({ level, bandIndex: index, reached: true, confidence: 'good', perBand: [] });

test('pace never tells a struggling learner to take on more', () => {
  const struggling = pace(0.45);
  const coping = pace(0.8);
  const strong = pace(0.95);
  assert.ok(struggling.newPerDay < coping.newPerDay, 'low accuracy should mean fewer new words');
  assert.ok(coping.newPerDay < strong.newPerDay, 'high accuracy should allow more');
  assert.ok(struggling.why.includes('45%'));
});

test('pace is monotonic across the whole accuracy range', () => {
  let last = 0;
  for (let a = 0; a <= 1.0001; a += 0.05) {
    const p = pace(Math.min(1, a));
    assert.ok(p.newPerDay >= last, `new-words fell at accuracy ${a.toFixed(2)}`);
    assert.ok(p.dailyGoal > 0);
    last = p.newPerDay;
  }
});

test('with no history and no placement the pace holds where the learner is', () => {
  const p = pace(null, 7);
  assert.equal(p.newPerDay, 7);
  assert.match(p.why, /No review history/);
});

test('a first-day pace comes from the placement, not the exam score', () => {
  // An adaptive exam drives every learner towards ~50%, so exam accuracy says
  // nothing about capacity. Only whether — and how high — they placed does.
  const strong = pace(null, 10, { ...at('B2', 2), accuracy: 0.5 });
  const modest = pace(null, 10, { ...at('A2', 0), accuracy: 0.5 });
  const unplaced = pace(null, 10, { level: 'A2', bandIndex: 0, reached: false, accuracy: 0.5 });

  assert.ok(strong.newPerDay > modest.newPerDay, 'a higher placement should carry more');
  assert.ok(modest.newPerDay > unplaced.newPerDay, 'an unplaced learner should start smallest');
  assert.match(unplaced.why, /did not find a level/);
  assert.match(strong.why, /B2/);
});

test('review accuracy overrules the placement once there is history', () => {
  // A week of 45% accuracy must slow a learner down even if they placed high.
  const p = pace(0.45, 10, at('C2', 3));
  assert.ok(p.newPerDay <= 3);
  assert.match(p.why, /45%/);
});

test('the ranking prefers a module that stretches over one that revises', () => {
  const manifest = [
    { id: 'revision', title: 'Revision' },
    { id: 'stretch', title: 'Stretch' },
    { id: 'far', title: 'Far above' },
  ];
  // Learner is at Moderate (index 1).
  const mix = {
    revision: { Easy: 380, Moderate: 20 },                 // all below/at
    stretch: { Moderate: 150, Advanced: 250 },             // at + one above
    far: { 'God Level': 400 },                             // two bands above
  };
  const ranked = rankModules(at('B1', 1), manifest, mix);
  assert.equal(ranked[0].id, 'stretch');
  assert.ok(ranked.findIndex((r) => r.id === 'far') > 0);
  assert.match(ranked[0].why, /above your level/);
});

test('the same module ranks differently for a stronger learner', () => {
  const manifest = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  const mix = { a: { Easy: 400 }, b: { Advanced: 300, 'God Level': 100 } };
  assert.equal(rankModules(at('A2', 0), manifest, mix)[0].id, 'a');
  assert.equal(rankModules(at('B2', 2), manifest, mix)[0].id, 'b');
});

test('a module with no band data still ranks rather than vanishing', () => {
  const ranked = rankModules(at('B1', 1), [{ id: 'x', title: 'X' }], {});
  assert.equal(ranked.length, 1);
  assert.ok(Number.isFinite(ranked[0].fit));
  assert.ok(ranked[0].why);
});

test('the plan flags a level it could not actually measure', () => {
  const plan = buildPlan({
    estimate: { level: 'A2', bandIndex: 0, reached: false, confidence: 'rough' },
    manifest: [], accuracy: 0.8,
  });
  assert.ok(plan.notes.some((n) => /did not find a band/.test(n)));
  assert.ok(plan.notes.some((n) => /provisional/.test(n)));
});

test('a confident result carries no caveats', () => {
  const plan = buildPlan({
    estimate: at('B2', 2), manifest: [], accuracy: 0.85,
  });
  assert.deepEqual(plan.notes, []);
});

test('the change list names only what would really change', () => {
  const estimate = at('B2', 2);
  const unchanged = buildPlan({
    estimate, manifest: [], accuracy: 0.8,
    current: { level: 'B2', newPerDay: 10, dailyGoal: 25 },
  });
  assert.deepEqual(unchanged.changes, [], 'nothing differs, so nothing should be listed');

  const moved = buildPlan({
    estimate, manifest: [], accuracy: 0.8,
    current: { level: 'A2', newPerDay: 3, dailyGoal: 15 },
  });
  assert.equal(moved.changes.length, 3);
  assert.ok(moved.changes.some((c) => c.includes('A2 → B2')));
});

test('struggling words are surfaced and counted', () => {
  const weak = Array.from({ length: 9 }, (_, i) => ({ term: `word${i}` }));
  const plan = buildPlan({ estimate: at('B1', 1), manifest: [], accuracy: 0.7, weak });
  assert.equal(plan.revisit.length, 6, 'the list is capped for the UI');
  assert.ok(plan.notes.some((n) => n.includes('9 words')));
});

test('cefrIndex orders the levels and survives nonsense', () => {
  assert.ok(cefrIndex('A1') < cefrIndex('B1'));
  assert.ok(cefrIndex('B2') < cefrIndex('C2'));
  assert.equal(cefrIndex('nonsense'), 0);
});
