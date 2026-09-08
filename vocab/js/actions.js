/**
 * What the assistant is allowed to do, as opposed to say.
 *
 * Every entry is one thing the learner could have done themselves through the
 * interface. That is the boundary, and it is deliberate: an assistant that can
 * reach anything will eventually reach something nobody asked for, and the
 * person it happens to has no way to see what it touched or put it back.
 *
 * Three rules hold for all of them.
 *
 *   1. Narrow. Each action takes named arguments with a stated range, and
 *      refuses anything outside it. A model that hallucinates "set the daily
 *      goal to 90,000" gets a refusal, not a ruined schedule.
 *   2. Visible. Each returns a plain sentence saying what changed, which the
 *      app shows. Nothing happens silently.
 *   3. Reversible. Anything that writes returns an `undo`, and the app offers
 *      it. Consent after the fact is worth little without a way out.
 *
 * The actions run on the device, against the learner's own state. The model
 * only ever names one and its arguments; it never receives the state to
 * modify, and it cannot reach storage, the network, or another learner.
 */
import { ACTIONS as ROUTINE_ACTIONS, makeStep, validTime, sortRoutine, QUOTES, quoteFor }
  from './routine.js';
import { dayKey } from './store.js';
import { summary, weakest } from './stats.js';

/** Bounds that exist so a confident wrong answer cannot become a bad day. */
export const BOUNDS = {
  dailyGoal: [5, 200],
  newPerDay: [1, 50],
  routineSteps: 8,
};

const clamp = (n, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(Number(n))));
const inRange = (n, [lo, hi]) => Number.isFinite(Number(n)) && Number(n) >= lo && Number(n) <= hi;

/**
 * The catalogue.
 *
 * `declare` is what the model is shown — Gemini's function-declaration shape.
 * `run` is what actually happens, and it never sees the model's raw text, only
 * arguments it has already validated.
 */
export const ACTIONS = {

  /* ── reading ─────────────────────────────────────────────────────────── */

  get_progress: {
    reads: true,
    declare: {
      name: 'get_progress',
      description: 'Read how the learner is doing: words known, streak, accuracy, '
        + 'minutes studied, and which words they keep getting wrong. Call this before '
        + 'giving advice about their study, so the advice is about them.',
      parameters: { type: 'object', properties: {} },
    },
    run(_args, { state }) {
      const s = summary(state);
      return {
        say: `${s.studied} words started, ${s.known} in long-term review, `
          + `${s.streak}-day streak, ${Math.round((s.accuracy7 || 0) * 100)}% correct this week.`,
        data: {
          words: s.total, studied: s.studied, known: s.known,
          streak: s.streak, accuracy7: s.accuracy7, minutes7: s.minutes7,
          reviewsToday: s.today?.reviews || 0,
          weakest: weakest(state, 6).map((w) => w.term),
        },
      };
    },
  },

  list_modules: {
    reads: true,
    declare: {
      name: 'list_modules',
      description: 'List the study packs and how far the learner has got in each. '
        + 'Use it to answer "what should I study" with a real pack name.',
      parameters: { type: 'object', properties: {} },
    },
    run(_args, { modules = [], state }) {
      /* How far in is computed here rather than read: the manifest ships with
         the app and knows nothing about this learner. */
      const started = new Set(Object.values(state?.words || {}).map((w) => w.module));
      const rows = modules.slice(0, 40).map((m) => ({
        id: m.id,
        name: m.title || m.id,
        level: m.level,
        group: m.group,
        words: m.count ?? 0,
        started: started.has(m.id),
      }));
      const going = rows.filter((r) => r.started).map((r) => r.name);
      return {
        say: going.length
          ? `${rows.length} packs; started: ${going.join(', ')}.`
          : `${rows.length} packs, none started yet.`,
        data: { modules: rows },
      };
    },
  },

  get_reminders: {
    reads: true,
    declare: {
      name: 'get_reminders',
      description: 'Read the times the learner is currently reminded to study, and '
        + 'whether reminders are switched on at all.',
      parameters: { type: 'object', properties: {} },
    },
    run(_args, { state }) {
      const r = state.settings.reminders || {};
      const steps = (r.routine || []).map((s) => `${s.time} ${s.action}`);
      return {
        say: r.enabled
          ? `Reminders are on: ${steps.join(', ') || 'none set'}.`
          : 'Reminders are switched off.',
        data: { enabled: Boolean(r.enabled), steps },
      };
    },
  },

  /* ── writing ─────────────────────────────────────────────────────────── */

  set_reminder: {
    declare: {
      name: 'set_reminder',
      description: 'Add or move a study reminder to a time of day. Use 24-hour '
        + '"HH:MM". Replaces the reminder with the same purpose if one exists.',
      parameters: {
        type: 'object',
        properties: {
          time: { type: 'string', description: 'Time of day, 24-hour, like "07:30" or "21:00".' },
          action: {
            type: 'string',
            enum: Object.keys(ROUTINE_ACTIONS),
            description: 'What the reminder is for. "review" is the usual one.',
          },
        },
        required: ['time'],
      },
    },
    run(args, { state, commit }) {
      if (!validTime(args.time)) {
        return { refused: `"${args.time}" is not a time of day. Use 24-hour HH:MM.` };
      }
      const action = ROUTINE_ACTIONS[args.action] ? args.action : 'review';
      const before = [...(state.settings.reminders.routine || [])];
      if (before.length >= BOUNDS.routineSteps
          && !before.some((s) => s.action === action)) {
        return { refused: `There are already ${BOUNDS.routineSteps} reminders, which is `
          + 'the most that is useful. Move one instead of adding another.' };
      }

      const kept = before.filter((s) => s.action !== action);
      const next = sortRoutine([...kept, { ...makeStep(args.time, action), time: args.time }]);
      commit('settings.reminders.routine', next);

      return {
        say: `Reminder for "${ROUTINE_ACTIONS[action].label}" set to ${args.time}.`,
        undo: () => commit('settings.reminders.routine', before),
        undoLabel: 'Put the old time back',
      };
    },
  },

  set_reminders_enabled: {
    declare: {
      name: 'set_reminders_enabled',
      description: 'Switch study reminders on or off for the whole app. Turning them '
        + 'on does not choose times — set_reminder does that. Only call this when the '
        + 'learner has said they do or do not want reminders.',
      parameters: {
        type: 'object',
        properties: { on: { type: 'boolean' } },
        required: ['on'],
      },
    },
    run(args, { state, commit }) {
      const before = Boolean(state.settings.reminders.enabled);
      const on = Boolean(args.on);
      if (before === on) return { say: `Reminders are already ${on ? 'on' : 'off'}.` };
      commit('settings.reminders.enabled', on);
      return {
        say: `Reminders switched ${on ? 'on' : 'off'}.`,
        undo: () => commit('settings.reminders.enabled', before),
        undoLabel: on ? 'Switch them back off' : 'Switch them back on',
      };
    },
  },

  set_daily_goal: {
    declare: {
      name: 'set_daily_goal',
      description: 'Set how many reviews a day counts as a full day. Between '
        + `${BOUNDS.dailyGoal[0]} and ${BOUNDS.dailyGoal[1]}.`,
      parameters: {
        type: 'object',
        properties: { reviews: { type: 'integer' } },
        required: ['reviews'],
      },
    },
    run(args, { state, commit }) {
      if (!inRange(args.reviews, BOUNDS.dailyGoal)) {
        return { refused: `A daily goal of ${args.reviews} is outside `
          + `${BOUNDS.dailyGoal[0]}–${BOUNDS.dailyGoal[1]}. Pick something reachable.` };
      }
      const before = state.settings.dailyGoal;
      const next = clamp(args.reviews, BOUNDS.dailyGoal);
      commit('settings.dailyGoal', next);
      return {
        say: `Daily goal set to ${next} reviews.`,
        undo: () => commit('settings.dailyGoal', before),
        undoLabel: `Back to ${before}`,
      };
    },
  },

  set_new_per_day: {
    declare: {
      name: 'set_new_per_day',
      description: 'Set how many new words are introduced each day. Between '
        + `${BOUNDS.newPerDay[0]} and ${BOUNDS.newPerDay[1]}. Lower it when the learner `
        + 'is struggling, raise it when they are finding it easy.',
      parameters: {
        type: 'object',
        properties: { words: { type: 'integer' } },
        required: ['words'],
      },
    },
    run(args, { state, commit }) {
      if (!inRange(args.words, BOUNDS.newPerDay)) {
        return { refused: `${args.words} new words a day is outside `
          + `${BOUNDS.newPerDay[0]}–${BOUNDS.newPerDay[1]}.` };
      }
      const before = state.settings.newPerDay;
      const next = clamp(args.words, BOUNDS.newPerDay);
      commit('settings.newPerDay', next);
      return {
        say: `New words per day set to ${next}.`,
        undo: () => commit('settings.newPerDay', before),
        undoLabel: `Back to ${before}`,
      };
    },
  },

  /* ── the phone ───────────────────────────────────────────────────────── */

  send_notification: {
    declare: {
      name: 'send_notification',
      description: 'Put a short message on the learner\'s phone now — it appears on '
        + 'the lock screen. Use it for encouragement they asked for, or to mark '
        + 'something they wanted flagging. Keep it under 120 characters. Do not use '
        + 'it to nag: only when the learner has asked for a reminder or a push.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A few words. Shown in bold.' },
          body: { type: 'string', description: 'One sentence.' },
        },
        required: ['title', 'body'],
      },
    },
    async run(args, { notify }) {
      const title = String(args.title || '').slice(0, 60).trim();
      const body = String(args.body || '').slice(0, 200).trim();
      if (!title) return { refused: 'A notification needs something to say.' };

      const sent = await notify(title, body);
      return sent
        ? { say: `Sent to the lock screen: "${title}"` }
        : { refused: 'Notifications are not switched on for VocabX, so nothing was sent. '
            + 'Settings → Reminders turns them on.' };
    },
  },

  send_motivation: {
    declare: {
      name: 'send_motivation',
      description: 'Put a motivational line on the lock screen, chosen for where the '
        + 'learner actually is rather than at random. Give your own line if you have '
        + 'a better one than the app\'s.',
      parameters: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'Optional. Leave empty to use one of the app\'s.' },
        },
      },
    },
    async run(args, { state, notify }) {
      const own = String(args.quote || '').slice(0, 160).trim();
      const line = own || quoteFor(dayKey(), QUOTES);
      const s = summary(state);
      const title = s.streak > 0 ? `Day ${s.streak}` : 'VocabX';

      const sent = await notify(title, typeof line === 'string' ? line : String(line?.text || ''));
      return sent
        ? { say: `Sent: "${typeof line === 'string' ? line : line?.text}"` }
        : { refused: 'Notifications are off, so nothing was sent.' };
    },
  },
};

/** What the model is shown. Reading actions first, so it looks before it acts. */
export function declarations() {
  return Object.values(ACTIONS).map((a) => a.declare);
}

/**
 * Run one action the model asked for.
 *
 * Refuses anything not in the catalogue by name. That check is the whole
 * boundary: a model that invents `delete_everything` gets a refusal, and the
 * refusal is worded so it can try something real instead.
 */
export async function runAction(name, args, ctx) {
  const action = ACTIONS[name];
  if (!action) {
    return { refused: `There is no "${name}" I can do. `
      + `What I can do: ${Object.keys(ACTIONS).join(', ')}.` };
  }
  try {
    return await action.run(args || {}, ctx);
  } catch (err) {
    // An action that throws must not take the conversation down with it.
    return { refused: `That did not work: ${err.message}` };
  }
}
