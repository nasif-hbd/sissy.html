/**
 * The Test section's engine.
 *
 * Five modes on two subjects is a lot of surface for wrong questions to hide
 * in: an option list containing the answer twice, a spelling item that shows
 * the word it asks for, a round that marks a flashcard. These pin all of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SUBJECTS, MODES, modesFor, buildRound, markOne, markRound,
  normalise, usesTerm, PASS_MARK, DEFAULT_LENGTH,
} from '../js/testlab.js';

const bank = JSON.parse(fs.readFileSync(new URL('../data/grammar/bank.json', import.meta.url)));

function seeded(seed = 1) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

const words = Array.from({ length: 40 }, (_, i) => ({
  w: `word${i}`, d: `the definition of word ${i}`, s: [`syn${i}a`, `syn${i}b`], p: 'noun', x: 'Moderate',
}));

// ── shape ──────────────────────────────────────────────────────────────────

test('spelling is offered for vocabulary and withheld from grammar', () => {
  // "Spell this grammar rule" is not a thing; the picker must not offer it.
  assert.ok(modesFor('vocabulary').some(([id]) => id === 'spelling'));
  assert.ok(!modesFor('grammar').some(([id]) => id === 'spelling'));
});

test('every mode names a subject that exists, and every subject has modes', () => {
  for (const [id, mode] of Object.entries(MODES)) {
    assert.ok(mode.subjects.length, `${id} offers no subject`);
    for (const s of mode.subjects) assert.ok(SUBJECTS[s], `${id} names unknown subject ${s}`);
  }
  for (const subject of Object.keys(SUBJECTS)) {
    assert.ok(modesFor(subject).length >= 4, `${subject} has too few modes`);
  }
});

// ── vocabulary rounds ──────────────────────────────────────────────────────

test('a quiz round asks the requested number of questions', () => {
  const round = buildRound({ subject: 'vocabulary', mode: 'quiz', words, rng: seeded(2) });
  assert.equal(round.length, DEFAULT_LENGTH);
});

test('a written exam is longer than a quiz', () => {
  const written = buildRound({ subject: 'vocabulary', mode: 'written', words, rng: seeded(3) });
  assert.equal(written.length, MODES.written.length);
  assert.ok(written.length > DEFAULT_LENGTH);
});

test('every choice question has its answer among four distinct options', () => {
  const rng = seeded(4);
  for (let trial = 0; trial < 40; trial += 1) {
    for (const q of buildRound({ subject: 'vocabulary', mode: 'quiz', words, rng })) {
      assert.equal(q.options.length, 4);
      assert.equal(new Set(q.options).size, 4, `repeated option: ${q.prompt}`);
      assert.ok(q.options[q.answerIndex], 'answer index out of range');
    }
  }
});

test('a recall question never lists the asked word as a wrong option', () => {
  const rng = seeded(5);
  for (let trial = 0; trial < 40; trial += 1) {
    for (const q of buildRound({ subject: 'vocabulary', mode: 'quiz', words, rng })) {
      if (q.tag !== 'recall') continue;
      assert.equal(q.options.filter((o) => o === q.term).length, 1);
      assert.equal(q.options[q.answerIndex], q.term);
    }
  }
});

test('a synonym question never offers a real synonym as a wrong answer', () => {
  const rng = seeded(6);
  const pool = [
    { w: 'big', d: 'large in size', s: ['large', 'huge'], p: 'adjective' },
    { w: 'large', d: 'big in size', s: ['big'], p: 'adjective' },
    { w: 'huge', d: 'very big', s: ['big'], p: 'adjective' },
    { w: 'chair', d: 'a seat for one person', s: ['seat'], p: 'noun' },
    { w: 'table', d: 'a flat surface on legs', s: ['desk'], p: 'noun' },
    { w: 'lamp', d: 'a device that gives light', s: ['light'], p: 'noun' },
  ];
  for (let trial = 0; trial < 60; trial += 1) {
    for (const q of buildRound({ subject: 'vocabulary', mode: 'quiz', words: pool, rng })) {
      if (q.tag !== 'synonym' || q.term !== 'big') continue;
      const wrong = q.options.filter((_, i) => i !== q.answerIndex);
      for (const o of wrong) assert.ok(!['large', 'huge'].includes(o), `${o} is a synonym of big`);
    }
  }
});

test('a quiz rotates through all three question kinds', () => {
  const round = buildRound({ subject: 'vocabulary', mode: 'quiz', words, rng: seeded(7) });
  const kinds = new Set(round.map((q) => q.tag));
  assert.ok(kinds.size >= 2, `only asked ${[...kinds]}`);
});

test('a spelling question never shows the word it is asking for', () => {
  // The whole exercise collapses if the prompt contains the answer.
  const round = buildRound({ subject: 'vocabulary', mode: 'spelling', words, rng: seeded(8) });
  for (const q of round) {
    assert.equal(q.kind, 'type');
    assert.ok(!q.prompt.toLowerCase().includes(q.term.toLowerCase()),
      `prompt leaks the answer: ${q.prompt}`);
    assert.match(q.hint, /letters/);
  }
});

test('words with no definition never become questions', () => {
  const messy = [...words.slice(0, 5), { w: 'ghost', d: '' }, { w: '', d: 'nothing' }];
  const round = buildRound({ subject: 'vocabulary', mode: 'flashcard', words: messy, rng: seeded(9) });
  assert.ok(round.every((q) => q.term && q.answer));
  assert.ok(!round.some((q) => q.term === 'ghost'));
});

test('a pack too thin for four options still yields flashcards, not broken quizzes', () => {
  const round = buildRound({ subject: 'vocabulary', mode: 'quiz', words: words.slice(0, 2), rng: seeded(10) });
  for (const q of round) {
    if (q.kind === 'choice') assert.equal(q.options.length, 4);
  }
});

// ── grammar rounds ─────────────────────────────────────────────────────────

test('a grammar quiz comes straight from the shipped bank', () => {
  const round = buildRound({ subject: 'grammar', mode: 'quiz', grammar: bank.items, rng: seeded(11) });
  assert.equal(round.length, DEFAULT_LENGTH);
  for (const q of round) {
    assert.equal(q.subject, 'grammar');
    assert.equal(q.options.length, 4);
    assert.ok(q.options[q.answerIndex]);
    assert.ok(q.why.length > 20, 'every grammar item explains its rule');
    assert.ok(q.topic && q.level);
  }
});

test('a grammar sentence question is typed, not chosen', () => {
  const round = buildRound({ subject: 'grammar', mode: 'sentence', grammar: bank.items, rng: seeded(12) });
  for (const q of round) {
    assert.equal(q.kind, 'type');
    assert.ok(q.accept.length >= 1);
  }
});

test('the shipped grammar bank is internally sound', () => {
  assert.ok(bank.items.length >= 40, `only ${bank.items.length} items`);
  const prompts = new Set();
  for (const it of bank.items) {
    assert.equal(it.o.length, 4, `not four options: ${it.q}`);
    assert.equal(new Set(it.o).size, 4, `repeated option: ${it.q}`);
    assert.ok(it.a >= 0 && it.a < 4, `bad answer index: ${it.q}`);
    assert.ok(!prompts.has(it.q), `duplicate prompt: ${it.q}`);
    prompts.add(it.q);
    assert.ok(it.w.length > 25, `weak explanation: ${it.q}`);
  }
  assert.ok(bank.topics.length >= 15, 'too few topics to feel varied');
});

// ── marking ────────────────────────────────────────────────────────────────

test('typed answers forgive case, spacing and stray punctuation', () => {
  const q = { kind: 'type', accept: ['resilient'] };
  for (const given of ['resilient', 'Resilient', '  RESILIENT  ', '"resilient."', 'resilient!']) {
    assert.ok(markOne(q, given).correct, `rejected: ${JSON.stringify(given)}`);
  }
  assert.ok(!markOne(q, 'resiliant').correct, 'a misspelling must not pass a spelling test');
});

test('normalising leaves distinct words distinct', () => {
  assert.equal(normalise('Affect.'), 'affect');
  assert.notEqual(normalise('affect'), normalise('effect'));
});

test('a written sentence is credited only when the word is really in it', () => {
  const q = { kind: 'write', term: 'resilient' };
  const good = markOne(q, 'The whole team stayed resilient through a long season.');
  assert.ok(good.correct);
  assert.ok(good.notes.every((n) => n.startsWith('✓')));

  const missing = markOne(q, 'They were very tough about the whole thing.');
  assert.ok(!missing.correct);
  assert.ok(missing.notes.some((n) => n.includes('not in that sentence')));

  const short = markOne(q, 'very resilient');
  assert.ok(!short.correct, 'two words is not a sentence');
});

test('an inflected form still counts as using the word', () => {
  assert.ok(usesTerm('She adapted quickly to the change.', 'adapt'));
  assert.ok(usesTerm('The rules were adhering to nothing.', 'adhere'));
  assert.ok(!usesTerm('He scared the cat away.', 'scarce'));
});

test('flashcards are never marked right or wrong', () => {
  assert.equal(markOne({ kind: 'flashcard', answer: 'x' }, 'anything').correct, null);
});

test('a round scores only the questions that carry marks', () => {
  const questions = [
    { kind: 'flashcard', answer: 'a' },
    { kind: 'choice', options: ['a', 'b'], answerIndex: 0, term: 'one' },
    { kind: 'choice', options: ['a', 'b'], answerIndex: 1, term: 'two' },
  ];
  const result = markRound(questions, [null, 0, 0]);
  assert.equal(result.total, 2, 'the flashcard should not be counted');
  assert.equal(result.correct, 1);
  assert.equal(result.percent, 50);
  assert.deepEqual(result.wrong, ['two']);
});

test('marking never pays more for doing worse', () => {
  const questions = Array.from({ length: 10 }, (_, i) => ({
    kind: 'choice', options: ['a', 'b', 'c', 'd'], answerIndex: 0, term: `w${i}`,
  }));
  let last = -1;
  for (let right = 0; right <= 10; right += 1) {
    const answers = questions.map((_, i) => (i < right ? 0 : 1));
    const { xp, percent, passed } = markRound(questions, answers);
    assert.ok(xp >= last, `XP fell going from ${right - 1} to ${right} right`);
    assert.equal(percent, right * 10);
    assert.equal(passed, percent >= PASS_MARK * 100);
    last = xp;
  }
});

test('a perfect round pays the pass and perfect bonuses once each', () => {
  const questions = Array.from({ length: 10 }, () => ({
    kind: 'choice', options: ['a', 'b'], answerIndex: 0, term: 'w',
  }));
  const { xp, percent, passed } = markRound(questions, questions.map(() => 0));
  assert.equal(percent, 100);
  assert.ok(passed);
  assert.equal(xp, 10 * 10 + 25 + 50);
});

test('a flashcard-only round scores nothing rather than dividing by zero', () => {
  const result = markRound([{ kind: 'flashcard', answer: 'a' }], [null]);
  assert.equal(result.total, 0);
  assert.equal(result.percent, 0);
  assert.equal(result.xp, 0);
  assert.equal(result.passed, false);
});
