/**
 * The placement exam.
 *
 * The exam claims to measure a level. These pin the things that would make the
 * claim false without anything visibly breaking: an item whose distractors are
 * easier than its answer, a ladder that doesn't move, an estimate that reads a
 * lucky single answer as a level, or a vocabulary figure invented from nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANDS, PLACEMENT, poolByBand, startPlacement, nextQuestion,
  answerPlacement, placementDone, estimate, knownWords,
} from '../js/placement.js';

/** A deterministic rng, so a failure is reproducible. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** A pool with enough words per band to build any item. */
function fakePool(perBand = 12) {
  const words = [];
  for (const band of BANDS) {
    for (let i = 0; i < perBand; i += 1) {
      const tag = band.id.replace(/\s/g, '').toLowerCase();
      words.push({
        w: `${tag}${i}`,
        d: `definition of ${tag} ${i}`,
        s: [`${tag}syn${i}`],
        x: band.id,
      });
    }
  }
  return poolByBand(words);
}

test('words without a definition never enter the pool', () => {
  const pool = poolByBand([
    { w: 'alpha', d: 'a thing', x: 'Easy' },
    { w: 'beta', d: '', x: 'Easy' },
    { w: 'gamma', x: 'Easy' },
    { w: 'delta', d: 'another', x: 'Nonsense Band' },
  ]);
  assert.deepEqual(pool.get('Easy').map((w) => w.w), ['alpha']);
  assert.ok(!pool.has('Nonsense Band'));
});

test('every distractor comes from the answer\'s own band', () => {
  // This is what makes the measurement mean anything: a rare word must not be
  // guessable by elimination against three everyday ones.
  const pool = fakePool();
  const byTerm = new Map();
  for (const [band, words] of pool) for (const w of words) byTerm.set(w.w, band);
  const byDef = new Map();
  for (const [band, words] of pool) for (const w of words) byDef.set(w.d, band);

  const rng = seeded(7);
  for (let trial = 0; trial < 200; trial += 1) {
    const run = startPlacement(fakePool());
    run.band = trial % BANDS.length;
    const q = nextQuestion(run, rng);
    assert.ok(q, 'expected a question');
    for (const option of q.options) {
      // Options are terms for recall/synonym and definitions for meaning.
      const band = byTerm.get(option) ?? byDef.get(option)
        ?? byTerm.get(String(option).replace(/syn\d+$/, '').replace(/^([a-z]+)/, '$1'));
      if (band) assert.equal(band, q.band, `option "${option}" is from ${band}, item is ${q.band}`);
    }
  }
});

test('an item always has its answer among four distinct options', () => {
  const rng = seeded(3);
  for (let trial = 0; trial < 300; trial += 1) {
    const run = startPlacement(fakePool());
    run.band = trial % BANDS.length;
    const q = nextQuestion(run, rng);
    assert.equal(q.options.length, PLACEMENT.options);
    assert.equal(new Set(q.options).size, PLACEMENT.options, 'options repeat');
    assert.ok(q.answerIndex >= 0 && q.answerIndex < PLACEMENT.options);
    assert.ok(q.options[q.answerIndex] != null);
  }
});

test('a recall item never offers the asked word as a wrong option', () => {
  const rng = seeded(11);
  for (let trial = 0; trial < 300; trial += 1) {
    const run = startPlacement(fakePool());
    const q = nextQuestion(run, rng);
    if (q.kind !== 'recall') continue;
    assert.equal(q.options[q.answerIndex], q.term);
    assert.equal(q.options.filter((o) => o === q.term).length, 1);
  }
});

test('a synonym item never offers a real synonym as a wrong option', () => {
  const words = [
    { w: 'big', d: 'large', s: ['large', 'huge'], x: 'Easy' },
    { w: 'large', d: 'big', s: ['big'], x: 'Easy' },
    { w: 'huge', d: 'very big', s: ['big'], x: 'Easy' },
    { w: 'chair', d: 'a seat', s: ['seat'], x: 'Easy' },
    { w: 'table', d: 'a flat surface', s: ['desk'], x: 'Easy' },
    { w: 'lamp', d: 'a light', s: ['light'], x: 'Easy' },
  ];
  const rng = seeded(5);
  for (let trial = 0; trial < 200; trial += 1) {
    const run = startPlacement(poolByBand(words));
    const q = nextQuestion(run, rng);
    if (q?.kind !== 'synonym' || q.term !== 'big') continue;
    const wrong = q.options.filter((_, i) => i !== q.answerIndex);
    for (const option of wrong) {
      assert.ok(!['large', 'huge'].includes(option), `"${option}" is a synonym of big but offered as wrong`);
    }
  }
});

/** A run with the calibration sweep already spent, to test the ladder alone. */
function ladderRun(pool = fakePool()) {
  const run = startPlacement(pool, { sweep: 0 });
  return run;
}

test('the ladder climbs on a right answer and drops on a wrong one', () => {
  const run = ladderRun();
  const rng = seeded(2);
  assert.equal(run.band, PLACEMENT.startBand);

  nextQuestion(run, rng);
  answerPlacement(run, run.question.answerIndex);          // right
  assert.equal(run.band, PLACEMENT.startBand + 1);

  nextQuestion(run, rng);
  answerPlacement(run, (run.question.answerIndex + 1) % 4); // wrong
  assert.equal(run.band, PLACEMENT.startBand);
});

test('the ladder never walks off either end', () => {
  const rng = seeded(4);
  const top = ladderRun();
  for (let i = 0; i < 12; i += 1) {
    nextQuestion(top, rng);
    answerPlacement(top, top.question.answerIndex);
  }
  assert.equal(top.band, BANDS.length - 1);

  const bottom = ladderRun();
  for (let i = 0; i < 12; i += 1) {
    nextQuestion(bottom, rng);
    answerPlacement(bottom, (bottom.question.answerIndex + 1) % 4);
  }
  assert.equal(bottom.band, 0);
});

test('no word is asked about twice in one sitting', () => {
  const run = startPlacement(fakePool());
  const rng = seeded(9);
  const seen = [];
  while (!placementDone(run)) {
    const q = nextQuestion(run, rng);
    assert.ok(q, 'the pool ran dry mid-exam');
    seen.push(q.term);
    answerPlacement(run, q.answerIndex);
  }
  assert.equal(new Set(seen).size, seen.length, 'a word was asked twice');
  assert.equal(run.asked.length, PLACEMENT.length);
});

test('a thin pool falls back to a neighbouring band rather than stalling', () => {
  // Only the two easy bands are populated; the ladder will try to climb past
  // them and must keep finding questions lower down.
  const words = [];
  for (const band of ['Easy', 'Moderate']) {
    for (let i = 0; i < 8; i += 1) words.push({ w: `${band}${i}`, d: `def ${band} ${i}`, s: [], x: band });
  }
  const run = startPlacement(poolByBand(words));
  const rng = seeded(6);
  for (let i = 0; i < PLACEMENT.length; i += 1) {
    const q = nextQuestion(run, rng);
    assert.ok(q, `ran out of questions at ${i}`);
    assert.ok(['Easy', 'Moderate'].includes(q.band));
    answerPlacement(run, q.answerIndex);
  }
  assert.equal(run.asked.length, PLACEMENT.length);
});

test('a pool too small to finish ends the sitting instead of hanging', () => {
  // Five words in one band: the exam can ask five questions, then must stop.
  const words = Array.from({ length: 5 }, (_, i) => ({ w: `w${i}`, d: `def ${i}`, s: [], x: 'Easy' }));
  const run = startPlacement(poolByBand(words));
  const rng = seeded(12);
  let asked = 0;
  while (!placementDone(run)) {
    const q = nextQuestion(run, rng);
    if (!q) break;
    asked += 1;
    answerPlacement(run, q.answerIndex);
  }
  assert.ok(placementDone(run), 'the run never reported itself finished');
  assert.equal(asked, 5, 'should ask exactly as many questions as there are words');
  assert.equal(estimate(run).answered, 5);
});

test('answering everything right places the learner at the top band', () => {
  const run = startPlacement(fakePool(20));
  const rng = seeded(8);
  while (!placementDone(run)) {
    nextQuestion(run, rng);
    answerPlacement(run, run.question.answerIndex);
  }
  const e = estimate(run);
  assert.equal(e.level, 'C2');
  assert.equal(e.accuracy, 1);
  assert.ok(e.reached);
});

test('answering everything wrong does not award a level', () => {
  const run = startPlacement(fakePool(20));
  const rng = seeded(10);
  while (!placementDone(run)) {
    nextQuestion(run, rng);
    answerPlacement(run, (run.question.answerIndex + 1) % 4);
  }
  const e = estimate(run);
  assert.equal(e.reached, false);
  assert.equal(e.level, BANDS[0].cefr);
  assert.equal(e.correct, 0);
});

test('a single lucky answer in a band is not read as holding it', () => {
  // One item at Advanced, answered right, is below minItems — it must not lift
  // the estimate to B2 on its own.
  const run = startPlacement(fakePool());
  run.asked = [
    { band: 'Easy', kind: 'meaning', term: 'a', correct: true },
    { band: 'Easy', kind: 'recall', term: 'b', correct: true },
    { band: 'Moderate', kind: 'meaning', term: 'c', correct: true },
    { band: 'Moderate', kind: 'recall', term: 'd', correct: true },
    { band: 'Advanced', kind: 'meaning', term: 'e', correct: true },
  ];
  const e = estimate(run);
  assert.equal(e.level, 'B1', 'one Advanced item should not make a B2');
  assert.equal(e.perBand.find((b) => b.band === 'Advanced').judged, false);
});

test('confidence falls when few bands got enough questions', () => {
  const thin = startPlacement(fakePool());
  thin.asked = [
    { band: 'Easy', correct: true }, { band: 'Easy', correct: true },
    { band: 'Moderate', correct: true },
  ];
  assert.equal(estimate(thin).confidence, 'rough');

  const wide = startPlacement(fakePool());
  wide.asked = [];
  for (const band of ['Easy', 'Moderate', 'Advanced']) {
    wide.asked.push({ band, correct: true }, { band, correct: true });
  }
  assert.equal(estimate(wide).confidence, 'good');
});

test('the vocabulary figure is measured accuracy over the words we hold', () => {
  const perBand = [
    { band: 'Easy', accuracy: 1 },
    { band: 'Moderate', accuracy: 0.5 },
    { band: 'Advanced', accuracy: 0 },
    { band: 'God Level', accuracy: null },   // never asked
  ];
  const sizes = { Easy: 100, Moderate: 200, Advanced: 300, 'God Level': 400 };
  const out = knownWords(perBand, sizes);
  assert.equal(out.known, 200);              // 100 + 100 + 0, unasked band contributes nothing
  assert.equal(out.total, 1000);
  assert.ok(out.known <= out.total);
});

test('a band never asked about contributes nothing to the estimate', () => {
  const out = knownWords([{ band: 'Easy', accuracy: null }], { Easy: 500 });
  assert.equal(out.known, 0);
});

// ── the calibration sweep ──────────────────────────────────────────────────

test('the sweep visits every band before the ladder starts', () => {
  const run = startPlacement(fakePool(20));
  const rng = seeded(21);
  const bands = [];
  for (let i = 0; i < BANDS.length * PLACEMENT.sweep; i += 1) {
    const q = nextQuestion(run, rng);
    bands.push(q.band);
    answerPlacement(run, q.answerIndex);
  }
  for (const band of BANDS) {
    const seen = bands.filter((b) => b === band.id).length;
    assert.equal(seen, PLACEMENT.sweep, `${band.id} got ${seen} sweep items`);
  }
});

test('the sweep spreads across bands before repeating one', () => {
  // An exam abandoned after four questions should still have touched all four
  // bands, not asked two easy words twice.
  const run = startPlacement(fakePool(20));
  const rng = seeded(22);
  const bands = [];
  for (let i = 0; i < BANDS.length; i += 1) {
    const q = nextQuestion(run, rng);
    bands.push(q.band);
    answerPlacement(run, q.answerIndex);
  }
  assert.equal(new Set(bands).size, BANDS.length, `only saw ${new Set(bands).size} bands`);
});

test('a flawless sitting is reported as firm, not provisional', () => {
  // The whole point of the sweep: before it, a perfect run pinned to the top
  // band and left every other band with one item, so it could not be judged.
  const run = startPlacement(fakePool(30));
  const rng = seeded(23);
  while (!placementDone(run)) {
    const q = nextQuestion(run, rng);
    answerPlacement(run, q.answerIndex);
  }
  const e = estimate(run);
  assert.equal(e.level, 'C2');
  assert.equal(e.confidence, 'good', 'every band should have enough items to judge');
  assert.ok(e.perBand.every((b) => b.judged), 'a band was left unjudged');
});

test('the ladder hands over at the boundary the sweep found, not where it ended', () => {
  // The sweep's last item is always the hardest band. Taking the ladder's
  // position from that item would start every learner near the top whatever
  // they scored, which is what used to happen.
  const wrong = startPlacement(fakePool(30));
  const rng = seeded(24);
  for (let i = 0; i < BANDS.length * PLACEMENT.sweep; i += 1) {
    const q = nextQuestion(wrong, rng);
    answerPlacement(wrong, (q.answerIndex + 1) % 4);
  }
  assert.equal(wrong.sweep.length, 0);
  assert.equal(wrong.band, 0, 'nothing passed, so the ladder starts at the bottom');

  const perfect = startPlacement(fakePool(30));
  for (let i = 0; i < BANDS.length * PLACEMENT.sweep; i += 1) {
    const q = nextQuestion(perfect, rng);
    answerPlacement(perfect, q.answerIndex);
  }
  assert.equal(perfect.band, BANDS.length - 1, 'everything passed, so it starts at the top');
});

test('the ladder hands over one rung above the hardest band passed', () => {
  const run = startPlacement(fakePool(30));
  const rng = seeded(26);
  for (let i = 0; i < BANDS.length * PLACEMENT.sweep; i += 1) {
    const q = nextQuestion(run, rng);
    // Right up to and including Moderate, wrong above it.
    const easy = q.band === 'Easy' || q.band === 'Moderate';
    answerPlacement(run, easy ? q.answerIndex : (q.answerIndex + 1) % 4);
  }
  assert.equal(run.band, 2, 'passed Moderate (1), so probe Advanced (2)');
});

test('a learner who fails only the hardest band places one band below it', () => {
  const run = startPlacement(fakePool(30));
  const rng = seeded(25);
  while (!placementDone(run)) {
    const q = nextQuestion(run, rng);
    const right = q.band !== 'God Level';
    answerPlacement(run, right ? q.answerIndex : (q.answerIndex + 1) % 4);
  }
  const e = estimate(run);
  assert.equal(e.level, 'B2', 'should place at Advanced, the highest band held');
  assert.equal(e.perBand.find((b) => b.band === 'God Level').accuracy, 0);
  assert.ok(e.perBand.find((b) => b.band === 'Advanced').accuracy >= 0.7);
});
