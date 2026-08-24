/**
 * The exam engine.
 *
 * Two classes of bug matter here: a question whose right answer is missing or
 * ambiguous, and a mark that does not match what the learner actually did.
 * Everything below is deterministic — the shuffle takes an injectable rng.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExam, markExam, chunk, EXAM_XP, QUESTION_KINDS } from '../js/exam.js';

const fixedRng = () => 0.42;

const words = [
  { term: 'abate', definition: 'become less intense', examples: ['The storm began to abate by morning.'] },
  { term: 'candid', definition: 'honest and straightforward', examples: ['She gave a candid account of the mistake.'] },
  { term: 'frugal', definition: 'careful with money', examples: [] },
  { term: 'lucid', definition: 'clear and easy to follow', examples: ['His explanation was lucid throughout.'] },
  { term: 'prudent', definition: 'acting with care for the future', examples: [] },
];

test('every question has its correct answer among the options', () => {
  const exam = buildExam(words, [], fixedRng);
  assert.ok(exam.length >= 4, `expected a question per word, got ${exam.length}`);
  for (const q of exam) {
    assert.ok(q.answerIndex >= 0, `${q.term}: correct answer missing from options`);
    assert.equal(q.options[q.answerIndex], q.correct);
    assert.ok(q.options.length >= 3, `${q.term}: too few options`);
    assert.equal(new Set(q.options).size, q.options.length, `${q.term}: duplicate options`);
    assert.ok(QUESTION_KINDS.includes(q.kind));
  }
});

test('all three kinds appear when the words support them', () => {
  const kinds = new Set(buildExam(words, [], fixedRng).map((q) => q.kind));
  for (const kind of QUESTION_KINDS) assert.ok(kinds.has(kind), `no ${kind} question generated`);
});

test('a usage question blanks the word out of its own sentence', () => {
  const exam = buildExam(words, [], fixedRng);
  const usage = exam.find((q) => q.kind === 'usage');
  assert.ok(usage.prompt.includes('_____'), 'the gap is missing');
  assert.ok(!new RegExp(usage.correct, 'i').test(usage.prompt),
    `the answer is still visible in the prompt: ${usage.prompt}`);
});

test('words with no example never produce a usage question', () => {
  const noExamples = words.map((w) => ({ ...w, examples: [] }));
  const kinds = new Set(buildExam(noExamples, [], fixedRng).map((q) => q.kind));
  assert.ok(!kinds.has('usage'));
  assert.ok(kinds.has('meaning') && kinds.has('recall'), 'should fall back to the other two');
});

test('a set too small to make distractors produces nothing rather than a broken question', () => {
  const exam = buildExam(words.slice(0, 1), [], fixedRng);
  assert.deepEqual(exam, []);
});

test('extra pool words are used as distractors', () => {
  const pair = words.slice(0, 2);
  const exam = buildExam(pair, words.slice(2), fixedRng);
  assert.ok(exam.length === 2, 'both words should be examinable with a pool');
  for (const q of exam) assert.ok(q.options.length >= 3);
});

// ── marking ────────────────────────────────────────────────────────────────
const exam = buildExam(words, [], fixedRng);
const allRight = exam.map((q) => q.answerIndex);
const allWrong = exam.map((q) => (q.answerIndex + 1) % q.options.length);

test('a perfect paper earns per-question XP plus both bonuses', () => {
  const result = markExam(exam, allRight);
  assert.equal(result.correct, exam.length);
  assert.equal(result.percent, 100);
  assert.ok(result.passed);
  assert.equal(result.xp, exam.length * EXAM_XP.perCorrect + EXAM_XP.passBonus + EXAM_XP.perfectBonus);
  assert.deepEqual(result.wrong, []);
});

test('a blank paper scores zero and earns nothing', () => {
  const result = markExam(exam, exam.map(() => -1));
  assert.equal(result.correct, 0);
  assert.equal(result.percent, 0);
  assert.equal(result.xp, 0);
  assert.equal(result.passed, false);
  assert.equal(result.wrong.length, exam.length);
});

test('XP tracks the mark, and the pass bonus lands exactly at the pass mark', () => {
  const scores = exam.map((_, i) => (i < exam.length - 1 ? allRight[i] : allWrong[i]));
  const nearly = markExam(exam, scores);
  assert.ok(nearly.percent < 100 && nearly.percent > 0);
  assert.equal(nearly.xp, nearly.correct * EXAM_XP.perCorrect + (nearly.passed ? EXAM_XP.passBonus : 0));
  assert.equal(nearly.passed, nearly.percent >= EXAM_XP.passMark);
});

test('marking never rewards more for doing worse', () => {
  let last = Infinity;
  for (let right = exam.length; right >= 0; right -= 1) {
    const answers = exam.map((q, i) => (i < right ? q.answerIndex : -1));
    const { xp } = markExam(exam, answers);
    assert.ok(xp <= last, 'fewer correct answers paid more');
    last = xp;
  }
});

test('the wrong list names exactly the words that were missed', () => {
  const answers = exam.map((q, i) => (i === 0 ? -1 : q.answerIndex));
  const result = markExam(exam, answers);
  assert.deepEqual(result.wrong, [exam[0].term]);
});

// ── sets ───────────────────────────────────────────────────────────────────
test('a module splits into whole sets with a short last one', () => {
  const sets = chunk(Array.from({ length: 25 }, (_, i) => i), 10);
  assert.equal(sets.length, 3);
  assert.deepEqual(sets.map((s) => s.length), [10, 10, 5]);
});

test('an empty module produces no sets', () => {
  assert.deepEqual(chunk([], 10), []);
});
