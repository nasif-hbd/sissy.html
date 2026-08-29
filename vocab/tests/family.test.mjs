import test from 'node:test';
import assert from 'node:assert/strict';
import { sameFamily, stemOf } from '../scripts/family.mjs';

/*
 * The rule that stops a pack teaching one word five times. Both halves matter:
 * folding too little leaves "visualise / visualize / visualisation" in a pack,
 * folding too much loses "country" because a pack already holds "count".
 */

test('folds a word family into one member', () => {
  for (const [a, b] of [
    ['global', 'globalization'],
    ['visualise', 'visualization'],
    ['process', 'processing'],
    ['region', 'regional'],
    ['conform', 'conformity'],
    ['emphasis', 'emphasize'],
    ['analyse', 'analysis'],
    ['distribute', 'distribution'],
    ['issue', 'issuing'],
    ['assist', 'assistant'],
    ['consider', 'considerable'],
    ['danger', 'dangerous'],
    ['interpret', 'interpretation'],
  ]) {
    assert.equal(sameFamily(a, b), true, `${a} / ${b} should be one family`);
    assert.equal(sameFamily(b, a), true, 'the rule is symmetric');
  }
});

test('keeps words that only look related', () => {
  for (const [a, b] of [
    ['count', 'country'],          // "ry" is not a suffix
    ['control', 'controversy'],
    ['cover', 'covert'],
    ['person', 'personnel'],
    ['cabin', 'cabinet'],
    ['comment', 'commence'],
    ['complete', 'complex'],
    ['continue', 'continent'],
    ['present', 'preserve'],
    ['material', 'maternal'],
    ['hear', 'heart'],
    ['star', 'start'],
    ['wind', 'window'],
    ['transfer', 'transform'],
    ['distribute', 'district'],
    ['particular', 'participant'],
  ]) {
    assert.equal(sameFamily(a, b), false, `${a} / ${b} are two words`);
  }
});

test('a word is its own family', () => {
  assert.equal(sameFamily('abandon', 'abandon'), true);
});

test('British and American spellings are the same word', () => {
  assert.equal(stemOf('globalise'), stemOf('globalize'));
  assert.equal(stemOf('analyse'), stemOf('analyze'));
  assert.equal(stemOf('colour'), 'color');
  assert.equal(sameFamily('organisation', 'organization'), true);
});

test('short words are never folded together', () => {
  // Four shared letters is the floor; below it there is nothing to judge on.
  assert.equal(sameFamily('cat', 'cats'), false);
  assert.equal(sameFamily('read', 'real'), false);
});
