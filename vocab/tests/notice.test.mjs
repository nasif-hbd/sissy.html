/**
 * The assistant speaking without being asked.
 *
 * Two things decide whether this feature is tolerable rather than clever, and
 * neither is the wording:
 *
 *   · how often it speaks — an assistant that remarks on every session is
 *     noise inside a week, and noise gets switched off, taking the one useful
 *     note with it;
 *   · what a suggestion is allowed to carry — the model is a stranger, and
 *     "set your daily goal to 90,000" must never reach the screen, not even
 *     attached to an action that would refuse it.
 *
 * So these are tests about restraint, not about output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldLook, worthSaying, validate, digest, suggestable, COOLDOWN_HOURS, PER_DAY }
  from '../js/notice.js';
import { ACTIONS } from '../js/actions.js';

const HOUR = 3_600_000;
const now = Date.parse('2026-09-05T12:00:00Z');
const today = '2026-09-05';

/** A learner with a fortnight behind them. */
function learner(over = {}) {
  const days = {};
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    days[d] = { reviews: 20, correct: 17, learned: 3, seconds: 600 };
  }
  return {
    settings: { notices: { enabled: true }, dailyGoal: 20, newPerDay: 10,
                reminders: { enabled: false } },
    words: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`w${i}`, { id: `w${i}`, term: `w${i}` }])),
    srs: Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
      [`w${i}`, { reps: 4, ease: 2.5, interval: 9, lapses: 0, due: now, lastReviewed: now }])),
    days,
    history: Array.from({ length: 60 }, (_, i) => ({ ts: now - i * 60_000, id: `w${i % 40}`, correct: true })),
    streak: { current: 5, longest: 9, lastActive: today },
    xp: { total: 300 },
    notices: [],
    profile: { level: 'B1' },
    ...over,
  };
}

const note = (over = {}) => ({
  id: 'n1', at: now - 6 * HOUR, day: today, kind: 'observation', text: 'x',
  state: 'dismissed', engine: 'Gemini',
  saw: { streak: 5, accuracy7: 0.85, reviews7: 140, studied: 40 },
  ...over,
});

// ── when it may speak ──────────────────────────────────────────────────────

test('it says nothing when it has been switched off', () => {
  const state = learner({ settings: { notices: { enabled: false } } });
  assert.equal(shouldLook(state, { now }), false);
});

test('it says nothing mid-session', () => {
  // A remark that lands during a review is an interruption, whatever it says.
  const state = learner();
  for (const view of ['learn', 'lesson', 'test', 'assess']) {
    assert.equal(shouldLook(state, { view, now }), false, `spoke during ${view}`);
  }
  assert.equal(shouldLook(state, { view: 'home', now }), true);
});

test('it says nothing to someone who has not started', () => {
  const state = learner({ srs: {}, history: [], days: {}, streak: { current: 0, longest: 0 } });
  // Home and the welcome screen both say it better than an assistant could.
  assert.equal(shouldLook(state, { now }), false);
});

test('one note at a time, and a wait between them', () => {
  const fresh = learner({ notices: [note({ at: now - 1 * HOUR })] });
  assert.equal(shouldLook(fresh, { now }), false, `spoke inside ${COOLDOWN_HOURS}h`);

  const cold = learner({ notices: [note({ at: now - (COOLDOWN_HOURS + 1) * HOUR, day: '2026-09-04' })] });
  assert.equal(shouldLook(cold, { now }), true);
});

test('a note still on screen stops the next one', () => {
  for (const state of ['open', 'done']) {
    const s = learner({ notices: [note({ at: now - 20 * HOUR, day: '2026-09-04', state })] });
    assert.equal(shouldLook(s, { now }), false, `stacked on top of a ${state} note`);
  }
});

test('a daily ceiling, however much changes', () => {
  const many = Array.from({ length: PER_DAY }, (_, i) =>
    note({ id: `n${i}`, at: now - (COOLDOWN_HOURS + 1 + i) * HOUR, day: today }));
  assert.equal(shouldLook(learner({ notices: many }), { now }), false);
});

// ── whether anything changed ───────────────────────────────────────────────

test('nothing new to see means nothing to say', () => {
  const state = learner();
  const last = note({ saw: { streak: 5, accuracy7: state.days ? 0.85 : 0, reviews7: 999, studied: 40 } });
  // Same streak, same accuracy, no new week of work: silence is the answer.
  assert.equal(worthSaying(state, { ...last, day: today, at: now - 6 * HOUR }), false);
});

test('a broken streak is worth a sentence', () => {
  const state = learner({ streak: { current: 0, longest: 9, lastActive: '2026-09-01' } });
  assert.equal(worthSaying(state, note({ saw: { streak: 5, accuracy7: 0.85, reviews7: 999 } })), true);
});

test('it looks again after two quiet days', () => {
  const state = learner();
  const stale = note({ at: now - 60 * HOUR, saw: { streak: 5, accuracy7: 0.85, reviews7: 999 } });
  assert.equal(worthSaying(state, stale), true);
});

// ── what it is allowed to see ──────────────────────────────────────────────

test('the digest carries counts and at most six terms, and nothing else', () => {
  const d = digest(learner(), { due: 7 });
  const allowed = new Set(['studied', 'known', 'streak', 'longest', 'dueNow', 'todayReviews',
    'dailyGoal', 'newPerDay', 'reviews7', 'accuracy7', 'minutes7', 'weakest',
    'remindersOn', 'enoughToJudge', 'lastNote']);
  for (const key of Object.keys(d)) assert.ok(allowed.has(key), `digest grew a ${key} field`);
  assert.ok(d.weakest.length <= 6);
  // The review log, the word list and anything typed stay on the device.
  const text = JSON.stringify(d);
  assert.ok(!text.includes('history'), 'the review log went out');
  assert.ok(!text.includes('"srs"'), 'the schedule went out');
});

// ── what a suggestion may carry ────────────────────────────────────────────

test('a suggestion naming something that does not exist becomes a remark', () => {
  const out = validate({ kind: 'suggestion', text: 'Try this.', action: 'delete_everything' }, {});
  assert.equal(out.kind, 'observation');
  assert.equal(out.action, undefined, 'an invented action reached the card');
});

test('a suggestion naming a read-only action becomes a remark', () => {
  // get_progress is real, and accepting it would do nothing visible — a
  // button that appears to change something and does not is worse than none.
  const out = validate({ kind: 'suggestion', text: 'Let me look.', action: 'get_progress' }, {});
  assert.equal(out.kind, 'observation');
});

test('every suggestable argument is one the action actually takes', () => {
  /* This is the test that was missing. A suggestion was built with `goal` and
     `count` against a catalogue that declares `reviews` and `words`, which
     produced a button reading "Set the goal to 30" that passed undefined to
     the action the moment it was pressed. Nothing was wrong with the words. */
  const samples = {
    set_daily_goal: { reviews: 30 },
    set_new_per_day: { words: 12 },
    set_reminders_enabled: { on: true },
    set_reminder: { time: '07:30', action: 'review' },
  };

  for (const [name, args] of Object.entries(samples)) {
    const out = validate({ kind: 'suggestion', text: 'Try this.', action: name, args }, {});
    assert.equal(out.kind, 'suggestion', `${name} was rejected outright`);

    const declared = Object.keys(ACTIONS[name].declare.parameters.properties || {});
    for (const key of Object.keys(out.args)) {
      assert.ok(declared.includes(key),
        `${name} would be sent "${key}", which it does not declare (it takes ${declared.join(', ')})`);
    }
    for (const need of ACTIONS[name].declare.parameters.required || []) {
      assert.ok(need in out.args, `${name} needs "${need}" and the suggestion carried none`);
    }
  }
});

test('an argument outside its range never reaches the screen', () => {
  /* Checked here as well as inside the action, because the button's label is
     built from these numbers: "Set the goal to 90,000" must not be rendered
     even attached to something that would refuse it. */
  for (const args of [{ reviews: 90000 }, { reviews: 0 }, { reviews: 'lots' }, {}, { goal: 30 }]) {
    const out = validate({ kind: 'suggestion', text: 'Raise it.', action: 'set_daily_goal', args }, {});
    assert.equal(out.kind, 'observation', `let through ${JSON.stringify(args)}`);
  }
  const good = validate({ kind: 'suggestion', text: 'Raise it.', action: 'set_daily_goal', args: { reviews: 30 } }, {});
  assert.equal(good.kind, 'suggestion');
  assert.deepEqual(good.args, { reviews: 30 });
});

test('it cannot suggest sending itself a notification', () => {
  // A notification the learner has to approve first is one they have read.
  for (const name of ['send_notification', 'send_motivation']) {
    const out = validate({ kind: 'suggestion', text: 'Ping you.', action: name, args: { text: 'hi' } }, {});
    assert.equal(out.kind, 'observation', `${name} was offered`);
  }
});

test('what it is offered is exactly what it is allowed to use', () => {
  const names = suggestable().map((a) => a.name);
  assert.ok(!names.includes('get_progress'), 'a read-only action was offered');
  assert.ok(names.includes('set_daily_goal'));
  for (const a of suggestable()) assert.ok(a.description, `${a.name} was offered with no description`);

  /* Offering something that will always be refused wastes a note and reads,
     to anyone watching the traffic, like a rule nobody enforces. */
  for (const name of names) {
    const out = validate({ kind: 'suggestion', text: 'x', action: name,
      args: { reviews: 30, words: 12, on: true, time: '07:30', action: 'review' } }, {});
    assert.equal(out.kind, 'suggestion', `${name} is offered but always refused`);
  }
});

test('a note always carries who wrote it and what it saw', () => {
  const out = validate({ kind: 'observation', text: 'Steady week.' },
    { engine: 'Gemini', model: 'gemini-flash-lite-latest', saw: { streak: 5, accuracy7: 0.9, reviews7: 140 }, now });
  assert.equal(out.engine, 'Gemini');
  assert.equal(out.model, 'gemini-flash-lite-latest');
  assert.equal(out.at, now);
  // Without `saw` the next check has nothing to compare against, and the
  // watcher either speaks every time or never again.
  assert.equal(out.saw.streak, 5);
});

test('an empty note is not a note', () => {
  assert.equal(validate({ kind: 'observation', text: '   ' }, {}), null);
  assert.equal(validate({}, {}), null);
  assert.equal(validate(null, {}), null);
});

test('an essay is cut to a remark', () => {
  const out = validate({ kind: 'observation', text: 'x'.repeat(2000) }, {});
  assert.ok(out.text.length <= 400);
});
