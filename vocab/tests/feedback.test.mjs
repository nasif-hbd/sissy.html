import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackAsText, feedbackSubject, feedbackMailto } from '../js/feedback.js';

/*
 * The hosted build has no server behind it, so "Send" could only ever save a
 * note on the device — which meant nobody read it. The mailto route is the one
 * that works with nothing running, so its encoding has to be right.
 */
const report = (over = {}) => ({
  kind: 'bug',
  text: 'The Test tab froze on question 3.',
  context: { view: 'test', screen: '390x844', provider: 'mock', level: 'B1' },
  ...over,
});

test('the note leads with what was said', () => {
  const text = feedbackAsText(report());
  assert.ok(text.startsWith('The Test tab froze on question 3.'));
  assert.match(text, /^kind bug$/m);
  assert.match(text, /^test · 390x844 · mock · level B1$/m);
});

test('a note with no context is still a note', () => {
  const text = feedbackAsText({ kind: 'idea', text: 'more phrasal verbs' });
  assert.equal(text, 'more phrasal verbs\n\n—\nkind idea');
});

test('the subject is one line, whatever was typed', () => {
  assert.equal(feedbackSubject(report()), 'VocabX bug: The Test tab froze on question 3.');
  const rambling = feedbackSubject(report({ text: 'a'.repeat(200) }));
  assert.equal(rambling.length, 'VocabX bug: '.length + 60);
  assert.doesNotMatch(feedbackSubject(report({ text: 'two\nlines' })), /\n/);
});

test('every part of the mailto is encoded', () => {
  const link = feedbackMailto(report({ text: 'a&b=c\nnext line' }), 'you@example.com');
  const url = new URL(link);
  assert.equal(url.protocol, 'mailto:');
  assert.equal(decodeURIComponent(url.pathname), 'you@example.com');
  const q = new URLSearchParams(url.search);
  // The ampersand and the newline are the two that truncate a body if raw.
  assert.match(q.get('body'), /^a&b=c\nnext line/);
  assert.equal(q.get('subject'), 'VocabX bug: a&b=c next line');
});

test('a space is a space, not a plus', () => {
  // URLSearchParams writes "+" for a space, which mail clients show literally.
  const link = feedbackMailto(report(), 'you@example.com');
  assert.ok(!link.includes('+'), 'no raw plus signs survive into the link');
  assert.match(new URLSearchParams(new URL(link).search).get('subject'), /^VocabX bug: The Test tab froze/);
});

test('an address with a plus tag survives', () => {
  const link = feedbackMailto(report(), 'you+vocabx@example.com');
  assert.equal(decodeURIComponent(new URL(link).pathname), 'you+vocabx@example.com');
});
