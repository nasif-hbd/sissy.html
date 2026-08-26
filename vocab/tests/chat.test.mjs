/**
 * Ask — reading the learner's question.
 *
 * The offline half has to work out what is being asked before it can answer
 * from the dictionary. These pin the parsing, because the failure is silent:
 * mis-read the question and it confidently answers a different one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { subjectOf, comparisonOf, intentOf, contextFor, HISTORY_LIMIT, STARTERS } from '../js/chat.js';

test('the word being asked about is found in the shapes people type', () => {
  const cases = [
    ['What does ubiquitous mean?', 'ubiquitous'],
    ['what does resilient mean', 'resilient'],
    ['meaning of meticulous', 'meticulous'],
    ['Define abate.', 'abate'],
    ['What is a quorum?', 'quorum'],
    ['Use meticulous in a sentence', 'meticulous'],
    ['examples of tangible', 'tangible'],
    ['synonyms for scarce', 'scarce'],
  ];
  for (const [q, want] of cases) {
    assert.equal(subjectOf(q), want, `failed on: ${q}`);
  }
});

test('a quoted word wins over the sentence around it', () => {
  assert.equal(subjectOf('I keep tripping over “resilient” — help?'), 'resilient');
  assert.equal(subjectOf('what does "abate" mean in this context'), 'abate');
});

test('an open question yields no word rather than a wrong one', () => {
  // These must fall through to Claude, not be answered about some stray token.
  for (const q of ['How do I improve my writing?', 'Why is English spelling like this?',
                   'Can you help me study?', 'hello', '']) {
    assert.equal(subjectOf(q), null, `wrongly extracted a word from: ${q}`);
  }
});

test('a comparison finds both words, in order', () => {
  assert.deepEqual(comparisonOf('What is the difference between affect and effect?'), ['affect', 'effect']);
  assert.deepEqual(comparisonOf('affect vs effect'), ['affect', 'effect']);
  assert.deepEqual(comparisonOf('affect versus effect'), ['affect', 'effect']);
  assert.deepEqual(comparisonOf('fewer or less?'), ['fewer', 'less']);
});

test('a sentence that merely contains "and" is not read as a comparison', () => {
  assert.equal(comparisonOf('I read books and articles every day'), null);
  assert.equal(comparisonOf('What does resilient mean?'), null);
});

test('the intent separates meaning, usage and synonyms', () => {
  assert.equal(intentOf('What does abate mean?'), 'meaning');
  assert.equal(intentOf('Use abate in a sentence'), 'usage');
  assert.equal(intentOf('examples of abate'), 'usage');
  assert.equal(intentOf('how would I use abate'), 'usage');
  assert.equal(intentOf('synonyms for abate'), 'synonyms');
  assert.equal(intentOf('another word for abate'), 'synonyms');
});

test('the context sent is the tail of the conversation, in API roles', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'tutor' : 'you', text: `m${i}`,
  }));
  const ctx = contextFor(messages);
  assert.equal(ctx.length, HISTORY_LIMIT, 'should cap the history');
  assert.equal(ctx.at(-1).content, 'm29', 'should keep the most recent turn');
  assert.ok(ctx.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.equal(ctx.find((m) => m.content === 'm28').role, 'user');
});

test('a reply still streaming is never sent back as context', () => {
  const ctx = contextFor([
    { role: 'you', text: 'hello' },
    { role: 'tutor', text: 'partial…', pending: true },
  ]);
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].content, 'hello');
});

test('empty turns are dropped rather than sent as blank messages', () => {
  assert.deepEqual(contextFor([{ role: 'you', text: '' }, { role: 'tutor', text: null }]), []);
});

test('every starter prompt is one the offline half can actually answer', () => {
  // A starter that falls through to "needs Claude" makes the built-in tutor
  // look broken on the very first tap.
  const answerable = STARTERS.filter((q) => subjectOf(q) || comparisonOf(q));
  assert.ok(answerable.length >= 3, `only ${answerable.length} of ${STARTERS.length} starters are answerable offline`);
});
