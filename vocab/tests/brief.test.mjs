/**
 * What the assistant is told about you.
 *
 * Two things can go wrong here and neither shows up on screen. The snapshot
 * can carry more than it should — the whole point is that it is derived, so a
 * raw history or a word list slipping in is a leak nobody would notice. And
 * it can read a trend into three reviews, which is how an assistant starts
 * confidently telling a beginner they are plateauing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { learningBrief, briefText, headline, prompts, ENOUGH } from '../js/brief.js';
import { dayKey } from '../js/store.js';

/** A state with `n` graded reviews behind it, and one word getting missed. */
function stateWith(n, { wrongTerm = 'obdurate' } = {}) {
  const words = { w1: { term: wrongTerm }, w2: { term: 'lucid' } };
  const history = [];
  for (let i = 0; i < n; i++) {
    history.push({ wordId: i % 3 === 0 ? 'w1' : 'w2', correct: i % 3 !== 0, at: Date.now() - i * 1000 });
  }
  return {
    words,
    srs: { w1: { reps: 2, lapses: 3, due: 0 }, w2: { reps: 9, interval: 40, due: 0 } },
    history,
    streak: { current: 4, longest: 9 },
    /* The seven-day window is read from the day ledger, not the history log —
       they are two different records and the brief uses both. */
    days: { [dayKey()]: { reviews: n, correct: Math.round(n * 0.7), learned: 2, seconds: n * 8 } },
    sessions: [],
  };
}

test('the snapshot carries counts, not the log it was derived from', () => {
  const brief = learningBrief(stateWith(60));
  const json = JSON.stringify(brief);

  // Everything the assistant needs to answer "how am I doing".
  for (const key of ['words', 'studied', 'known', 'streak', 'accuracy7', 'weakest']) {
    assert.ok(key in brief, `the snapshot has no ${key}`);
  }
  // And nothing it does not. A history array in here would be every word the
  // learner has ever been shown, leaving the device on every question.
  assert.ok(!('history' in brief), 'the raw history reached the snapshot');
  assert.ok(!json.includes('wordId'), 'history rows reached the snapshot');
  assert.ok(!('srs' in brief) && !('words' in brief && typeof brief.words === 'object'),
    'the word table reached the snapshot');
  assert.ok(json.length < 1200, `the snapshot is ${json.length} chars — too big to ride on every question`);
});

test('a thin history is flagged rather than read', () => {
  const thin = learningBrief(stateWith(3));
  assert.equal(thin.enough, false);
  assert.match(briefText(thin), /not much history/i,
    'the model was given numbers with no warning that they mean nothing yet');

  const thick = learningBrief(stateWith(ENOUGH + 10));
  assert.equal(thick.enough, true);
  assert.doesNotMatch(briefText(thick), /not much history/i);
});

test('an empty account produces a sentence, not a crash or a lie', () => {
  const empty = { words: {}, srs: {}, history: [], streak: {}, days: {}, sessions: [] };
  const brief = learningBrief(empty);
  assert.equal(brief.studied, 0);
  assert.equal(brief.enough, false);
  const text = briefText(brief);
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /undefined|NaN/, 'the snapshot has holes in it');
  assert.match(headline(brief, 0), /start anywhere/i);
});

test('the words being missed are named, so advice can be about them', () => {
  const brief = learningBrief(stateWith(60));
  assert.ok(brief.weakest.includes('obdurate'), 'the word being missed is not in the snapshot');
  assert.match(briefText(brief), /obdurate/);
});

test('the headline answers the only question worth answering instantly', () => {
  const brief = learningBrief(stateWith(60));
  // Due work is the one fact that changes what someone does in the next
  // minute, so it leads and it never waits on a request.
  assert.match(headline(brief, 12), /^12 cards due/);
  assert.match(headline(brief, 1), /^1 card due/, 'plural where there is one');
  assert.doesNotMatch(headline(brief, 0), /due right now/);
});

test('the offered questions fit the state they are offered in', () => {
  const brief = learningBrief(stateWith(60));

  const backlog = prompts(brief, 30).map((p) => p.label);
  assert.match(backlog[0], /right now/i, 'a learner with a backlog was not told to clear it');

  const clear = prompts(brief, 0).map((p) => p.label);
  assert.match(clear[0], /next/i, 'a learner with nothing due was told to do their reviews');

  // Never so many that the sheet becomes a menu.
  assert.ok(prompts(brief, 30).length <= 4);
  for (const p of prompts(brief, 5)) {
    assert.ok(p.label && p.ask, 'a prompt with nothing behind it');
    assert.ok(p.ask.length > p.label.length, 'the question sent is just the button text');
  }
});

test('a learner with nothing wrong is not asked why they keep failing', () => {
  const perfect = { ...stateWith(40), history: Array.from({ length: 40 },
    (_, i) => ({ wordId: 'w2', correct: true, at: Date.now() - i })) };
  const brief = learningBrief(perfect);
  assert.equal(brief.weakest.length, 0);
  assert.ok(!prompts(brief, 5).some((p) => /slipping/i.test(p.label)),
    'offered to explain failures to someone who has had none');
});
