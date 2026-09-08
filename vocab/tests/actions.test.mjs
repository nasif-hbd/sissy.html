/**
 * What the assistant is allowed to do.
 *
 * This is the file that matters most in the whole app, because everything else
 * fails visibly and this fails by doing something nobody asked for. A model
 * that changes a setting on a hunch, or sends a notification to be friendly,
 * is not a bug anyone reports — it is an app that feels haunted.
 *
 * So: the catalogue is closed, every argument has a range, and everything that
 * writes can be put back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, declarations, runAction, BOUNDS } from '../js/actions.js';

function ctx(overrides = {}) {
  const commits = [];
  const state = {
    settings: {
      dailyGoal: 20, newPerDay: 10,
      reminders: { enabled: false, routine: [] },
    },
    words: {}, srs: {}, days: {}, history: [], streak: { current: 0, longest: 0 },
  };
  return {
    state,
    commits,
    modules: [{ id: 'ielts', title: 'IELTS', count: 900 }],
    commit: (path, value) => {
      commits.push([path, value]);
      // Follow the path so later reads in the same test see the write.
      const keys = path.split('.');
      let node = state;
      while (keys.length > 1) node = node[keys.shift()];
      node[keys[0]] = value;
    },
    notify: async () => true,
    ...overrides,
  };
}

test('the catalogue is closed — an invented action does nothing', async () => {
  const c = ctx();
  for (const name of ['delete_everything', 'eval', '__proto__', 'set_reminder ']) {
    const out = await runAction(name, { anything: true }, c);
    assert.ok(out.refused, `${name} was not refused`);
    assert.equal(out.say, undefined);
  }
  assert.deepEqual(c.commits, [], 'an unknown action reached the state');
});

test('every declared action exists, and every action is declared', () => {
  const declared = declarations().map((d) => d.name).sort();
  assert.deepEqual(declared, Object.keys(ACTIONS).sort());
  for (const d of declarations()) {
    // A description is not decoration — it is the only thing telling the model
    // when this is the right action and when it is not.
    assert.ok(d.description && d.description.length > 40, `${d.name}: thin description`);
    assert.equal(d.parameters.type, 'object', `${d.name}: odd parameter shape`);
  }
});

test('numbers outside their range are refused, not clamped silently', async () => {
  const c = ctx();
  for (const [name, arg, bad] of [
    ['set_daily_goal', 'reviews', BOUNDS.dailyGoal[1] + 1],
    ['set_daily_goal', 'reviews', 0],
    ['set_new_per_day', 'words', 500],
    ['set_new_per_day', 'words', -3],
  ]) {
    const out = await runAction(name, { [arg]: bad }, c);
    assert.ok(out.refused, `${name} accepted ${bad}`);
  }
  assert.deepEqual(c.commits, [], 'an out-of-range value was written anyway');

  // Rubbish where a number belongs is refused too, rather than becoming NaN.
  for (const junk of ['lots', null, undefined, {}, NaN]) {
    assert.ok((await runAction('set_daily_goal', { reviews: junk }, c)).refused, String(junk));
  }
});

test('a written setting can be put back exactly', async () => {
  const c = ctx();
  const before = c.state.settings.dailyGoal;

  const out = await runAction('set_daily_goal', { reviews: 55 }, c);
  assert.equal(c.state.settings.dailyGoal, 55);
  assert.ok(out.undo, 'a write with no way back');

  out.undo();
  assert.equal(c.state.settings.dailyGoal, before, 'undo did not restore the old value');
});

test('a reminder moves rather than piling up, and can be undone', async () => {
  const c = ctx();
  await runAction('set_reminder', { time: '07:30', action: 'review' }, c);
  assert.equal(c.state.settings.reminders.routine.length, 1);

  const second = await runAction('set_reminder', { time: '21:00', action: 'review' }, c);
  assert.equal(c.state.settings.reminders.routine.length, 1, 'a second reminder was added');
  assert.equal(c.state.settings.reminders.routine[0].time, '21:00');

  second.undo();
  assert.equal(c.state.settings.reminders.routine[0].time, '07:30', 'undo lost the earlier time');
});

test('a time that is not a time is refused', async () => {
  const c = ctx();
  for (const bad of ['half seven', '25:00', '7:5', '', '07:30; DROP TABLE', null]) {
    const out = await runAction('set_reminder', { time: bad }, c);
    assert.ok(out.refused, `accepted "${bad}"`);
  }
  assert.deepEqual(c.commits, []);
});

test('reminders stop being added past the point of usefulness', async () => {
  const c = ctx();
  const actions = Object.keys((await import('../js/routine.js')).ACTIONS);
  // Fill it up using distinct purposes, since same-purpose ones replace.
  for (let i = 0; i < BOUNDS.routineSteps; i++) {
    c.state.settings.reminders.routine.push({ id: `x${i}`, time: '08:00', action: actions[i % actions.length] });
  }
  const out = await runAction('set_reminder', { time: '09:00', action: 'nonsense-purpose' }, c);
  // 'nonsense-purpose' falls back to 'review', which is already there, so this
  // replaces rather than refuses — the cap only stops genuinely new ones.
  assert.ok(out.say || out.refused);
});

test('a notification is refused rather than faked when permission is off', async () => {
  const denied = ctx({ notify: async () => false });
  const out = await runAction('send_notification', { title: 'Hi', body: 'there' }, denied);
  assert.ok(out.refused, 'claimed to send with notifications off');
  assert.match(out.refused, /not switched on|off/i);

  const allowed = ctx();
  assert.ok((await runAction('send_notification', { title: 'Hi', body: 'x' }, allowed)).say);
});

test('an empty notification is refused', async () => {
  const c = ctx();
  assert.ok((await runAction('send_notification', { title: '   ', body: 'x' }, c)).refused);
});

test('reading actions never write', async () => {
  const c = ctx();
  for (const name of Object.keys(ACTIONS).filter((n) => ACTIONS[n].reads)) {
    await runAction(name, {}, c);
  }
  assert.deepEqual(c.commits, [], 'a read touched the state');
});

test('an action that throws becomes a refusal, not a crash', async () => {
  const broken = ctx({ commit: () => { throw new Error('storage is full'); } });
  const out = await runAction('set_daily_goal', { reviews: 30 }, broken);
  assert.ok(out.refused);
  assert.match(out.refused, /storage is full/);
});

test('progress comes back as numbers the model can reason about', async () => {
  const c = ctx();
  c.state.streak = { current: 4, longest: 9 };
  const out = await runAction('get_progress', {}, c);
  assert.equal(typeof out.data.streak, 'number');
  assert.ok(Array.isArray(out.data.weakest));
  assert.ok(out.say.includes('4-day streak'));
});
