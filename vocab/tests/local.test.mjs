/**
 * The built-in tutor.
 *
 * These cover the half of the AI that answers without a network, because that
 * is the half every user meets first. The report test in particular pins the
 * payload keys: `reportPayload` in stats.js names them, and a rename there used
 * to silently drop a whole paragraph from the summary with nothing failing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { localCoach, localReport, usesWord } from '../js/local.js';
import { reportPayload } from '../js/stats.js';

test('a sentence is credited when the word appears in an inflected form', () => {
  assert.ok(usesWord('She adapted quickly to the new team.', 'adapt'));
  assert.ok(usesWord('The rules were adhering to nothing.', 'adhere'));
  assert.ok(usesWord('He is resilient.', 'resilient'));
  assert.ok(!usesWord('She was very tough about it.', 'resilient'));
});

test('short words are matched whole, not by a two-letter stem', () => {
  // "ads" stems to "ad", which would otherwise match "advance", "admit"…
  assert.ok(!usesWord('The advance was slow.', 'ads'));
  // "scarce" loses its silent -e to match "scarcely", but must not reach "scared".
  assert.ok(usesWord('A scarce resource.', 'scarce'));
  assert.ok(!usesWord('He scared the cat.', 'scarce'));
});

test('coaching names every fault it finds and confirms what is right', () => {
  const bad = localCoach('resilient', 'was tough');
  assert.match(bad, /cannot find “resilient”/);
  assert.match(bad, /Too short/);
  assert.match(bad, /capital letter/);
  assert.match(bad, /full stop/);

  const good = localCoach('resilient', 'The whole team stayed resilient through a long season.');
  assert.match(good, /✓ You used “resilient”/);
  assert.match(good, /Punctuation looks right/);
  assert.ok(!good.includes('Too short'));
});

test('an empty sentence asks for one instead of listing faults', () => {
  const out = localCoach('resilient', '   ');
  assert.match(out, /Write a sentence/);
  assert.ok(!out.includes('✗'));
});

test('the summary reads the keys reportPayload actually writes', () => {
  const state = {
    profile: { level: 'B1' },
    settings: { dailyGoal: 20 },
    words: {}, srs: {}, days: {}, history: [],
    streak: { current: 0, longest: 0 },
  };
  const payload = reportPayload(state);
  // Every key localReport reads has to exist on a real payload.
  for (const key of ['reviewsLast7Days', 'activeDaysLast7', 'accuracyLast7Days',
                     'streak', 'deckSize', 'knownWords', 'strugglingWords']) {
    assert.ok(key in payload, `reportPayload lost the key ${key}`);
  }
});

test('the summary quotes the accuracy it was given', () => {
  const text = localReport({
    reviewsLast7Days: 40, activeDaysLast7: 4, accuracyLast7Days: 91,
    streak: 4, deckSize: 60, knownWords: 12,
  });
  assert.match(text, /40 words across 4 days/);
  assert.match(text, /Accuracy 91%/);
  assert.match(text, /more new words per day/);
  assert.match(text, /Streak: 4 days/);
});

test('low accuracy advises slowing down rather than speeding up', () => {
  const text = localReport({ reviewsLast7Days: 30, activeDaysLast7: 3, accuracyLast7Days: 52 });
  assert.match(text, /slow the new words down/);
});

test('a quiet week says so without inventing numbers', () => {
  const text = localReport({ reviewsLast7Days: 0, activeDaysLast7: 0 });
  assert.match(text, /No reviews this week/);
  assert.ok(!text.includes('Accuracy'));
});

test('nothing in the summary tells the learner to go and configure a server', () => {
  const text = localReport({ reviewsLast7Days: 12, activeDaysLast7: 2, accuracyLast7Days: 80 });
  assert.ok(!/sample|proxy|connect/i.test(text), text);
});
