/**
 * The assistant, when nobody asked it anything.
 *
 * Everything else the engine does here is a reply: you press Assist, you type
 * a question, it answers. This is the other half — it watches how the study is
 * going and speaks up on its own, with a remark, a question, or a suggestion.
 *
 * ── Three rules, and the first one is the whole design ────────────────────
 *
 * 1. IT PROPOSES, IT DOES NOT ACT. A suggestion names an action from the
 *    catalogue in actions.js and stops there. Nothing runs until the learner
 *    presses Accept, and what runs then goes through the same runAction() and
 *    the same Undo as everything else. An assistant that changes your settings
 *    while you are not looking is not an assistant, and "it asked first" is
 *    not the same as "it asked afterwards".
 *
 *    This is also why a notice is one request that returns a structured note,
 *    rather than a tool loop. There is no round in which the model could
 *    write anything: the shape it answers in has no room for it.
 *
 * 2. IT IS SIGNED. Every note carries the engine, the model and the time, and
 *    says a machine wrote it. The app already refuses to let one engine's
 *    words be labelled as another's; unprompted words need that more, not
 *    less, because nobody invited them.
 *
 * 3. IT IS RARE. The rules below exist to keep it that way. An assistant that
 *    remarks on every session is noise within a week, and noise gets turned
 *    off — at which point the one time it had something worth saying is lost
 *    along with the rest.
 */
import { Store, dayKey } from './store.js';
import { learningBrief, headline, localAdvice } from './brief.js';
import { ACTIONS, BOUNDS } from './actions.js';

/** How long after one note before another may appear. */
export const COOLDOWN_HOURS = 5;
/** And a ceiling per day, however much changes. */
export const PER_DAY = 2;
/** Notes worth keeping. Older ones are history nobody reads. */
export const KEEP = 12;

/**
 * Screens where it must stay quiet.
 *
 * A remark that lands mid-review is an interruption, whatever it says. These
 * are the screens where someone is working rather than deciding what to do.
 */
const BUSY = new Set(['learn', 'lesson', 'test', 'assess']);

const hoursSince = (at) => (Date.now() - (at || 0)) / 3_600_000;

/**
 * Whether it is worth looking at all.
 *
 * Called on every render, so it is cheap and it says no nearly always. The
 * order matters: the settings check is first because someone who turned this
 * off should cost nothing, and the "anything to remark on" check is last
 * because it is the only one that reads the ledger.
 */
export function shouldLook(state = Store.state, { view = '', now = Date.now() } = {}) {
  const on = state.settings?.notices?.enabled;
  if (!on) return false;
  if (BUSY.has(view)) return false;

  const log = state.notices || [];
  const today = log.filter((n) => n.day === dayKey(new Date(now)));
  if (today.length >= PER_DAY) return false;

  const last = log[log.length - 1];
  if (last && (now - last.at) / 3_600_000 < COOLDOWN_HOURS) return false;
  // Still on screen, waiting to be closed. One at a time, always.
  if (last && (last.state === 'open' || last.state === 'done')) return false;

  /* An open question is a conversation already in progress. Stacking a second
     note on top of one nobody has answered is how a helpful thing becomes a
     pile of unread things. */
  if (last && last.kind === 'question' && last.state === 'open') return false;

  return worthSaying(state, last);
}

/**
 * Has anything changed enough to be worth a sentence?
 *
 * Without this it would speak on a timer, which is a different feature: a
 * scheduled remark is a reminder, and the app already has those. This one is
 * supposed to have noticed something.
 */
export function worthSaying(state, last) {
  const s = learningBrief(state);

  // Nothing has happened at all yet. The welcome screen and Home both already
  // say so more usefully than an assistant could.
  if (!s.studied) return false;

  // First time, once there is something to look at.
  if (!last) return s.reviews7 > 0;

  const then = last.saw || {};
  return (
    // A day rolled over with study in it.
    (s.todayReviews > 0 && last.day !== dayKey())
    // The streak moved either way — a break is the most useful thing to notice.
    || s.streak !== then.streak
    // Accuracy moved by more than noise.
    || Math.abs((s.accuracy7 || 0) - (then.accuracy7 || 0)) >= 0.08
    // A week's worth of new work since it last looked.
    || (s.reviews7 - (then.reviews7 || 0)) >= 20
    // Or it simply has not looked in a long time and there is study to see.
    || (hoursSince(last.at) >= 48 && s.reviews7 > 0)
  );
}

/**
 * What the engine is allowed to see.
 *
 * Counts, rates and at most six terms. Never the review log, never the word
 * list, never anything typed into Ask or feedback. A digest that fits in a
 * few hundred characters cannot leak what it does not contain — the same rule
 * the feedback report follows.
 */
export function digest(state = Store.state, { due = 0 } = {}) {
  const b = learningBrief(state);
  const log = state.notices || [];
  const last = log[log.length - 1];

  return {
    studied: b.studied,
    known: b.known,
    streak: b.streak,
    longest: b.longest,
    dueNow: due,
    todayReviews: b.todayReviews,
    dailyGoal: state.settings?.dailyGoal || 0,
    newPerDay: state.settings?.newPerDay || 0,
    reviews7: b.reviews7,
    accuracy7: Number((b.accuracy7 || 0).toFixed(2)),
    minutes7: b.minutes7,
    weakest: b.weakest.slice(0, 6),
    remindersOn: Boolean(state.settings?.reminders?.enabled),
    /* Enough history to read a trend, or not. Told plainly so it can say "too
       early to tell" instead of finding a pattern in four reviews. */
    enoughToJudge: b.enough,
    /* What it said last time and what came of it, so it neither repeats
       itself nor ignores an answer it was given. */
    lastNote: last ? { text: last.text, kind: last.kind, state: last.state,
                       answer: last.answer || null, hoursAgo: Math.round(hoursSince(last.at)) } : null,
  };
}

/**
 * Actions that write but must never be suggested.
 *
 * A notification the learner has to approve before it is sent is a
 * notification they have already read, so the button could only ever be a
 * worse version of the note it is attached to.
 */
const NEVER_SUGGEST = new Set(['send_notification', 'send_motivation']);

/**
 * The actions a suggestion may name.
 *
 * The same list `sane()` will accept, and that matters: offering the model
 * something it will always be refused for naming wastes a note and reads, to
 * anyone watching the traffic, like a rule nobody enforces.
 */
export function suggestable() {
  return Object.entries(ACTIONS)
    .filter(([name, a]) => !a.reads && !NEVER_SUGGEST.has(name))
    .map(([name, a]) => ({ name, description: a.declare.description }));
}

/**
 * A note from the model, checked before it is allowed on screen.
 *
 * The model is a stranger to this app: it can name an action that does not
 * exist, suggest a daily goal of nine hundred, or return three paragraphs
 * where a sentence was asked for. None of that may reach the learner as
 * though the app agreed with it.
 */
export function validate(raw, { engine, model, saw, now = Date.now() } = {}) {
  const kind = ['observation', 'question', 'suggestion'].includes(raw?.kind) ? raw.kind : 'observation';
  const text = String(raw?.text || '').trim().slice(0, 400);
  if (!text) return null;

  const note = {
    id: `n${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: now,
    day: dayKey(new Date(now)),
    engine: engine || 'Built-in tutor',
    model: model || '',
    kind,
    text,
    state: 'open',
    /* The four numbers it was looking at, kept so the next check can ask what
       has moved since. Without this worthSaying() has nothing to compare
       against and the watcher either speaks every time or never again. */
    saw: {
      streak: saw?.streak ?? 0,
      accuracy7: saw?.accuracy7 ?? 0,
      reviews7: saw?.reviews7 ?? 0,
      studied: saw?.studied ?? 0,
    },
  };

  if (kind === 'suggestion') {
    const name = String(raw?.action || '');
    const action = ACTIONS[name];
    /* Named something that does not exist, or something that only reads. A
       suggestion has to be a change the learner could accept; anything else
       becomes a plain remark rather than a button that does nothing. */
    if (!action || action.reads) return { ...note, kind: 'observation' };

    const args = sane(name, raw?.args);
    if (!args) return { ...note, kind: 'observation' };
    return { ...note, action: name, args, why: String(raw?.why || '').trim().slice(0, 200) };
  }

  return note;
}

/**
 * The one numeric argument each suggestable setting takes, and its range.
 *
 * The names come from the catalogue's own declarations, and a test checks that
 * they still do. They were invented here once — `goal` and `count` against a
 * catalogue that says `reviews` and `words` — which built a button reading
 * "Set the goal to 30" that passed `undefined` to the action when pressed.
 */
const NUMERIC = {
  set_daily_goal: { key: 'reviews', range: BOUNDS.dailyGoal },
  set_new_per_day: { key: 'words', range: BOUNDS.newPerDay },
};

/**
 * Arguments a suggestion may carry.
 *
 * Checked here as well as inside the action, because the button's label is
 * built from them — "Set your daily goal to 90,000" must never appear on
 * screen, even attached to something that would refuse it.
 */
function sane(name, raw) {
  const args = raw && typeof raw === 'object' ? raw : {};

  const numeric = NUMERIC[name];
  if (numeric) {
    const [lo, hi] = numeric.range;
    const value = Number(args[numeric.key]);
    return Number.isFinite(value) && value >= lo && value <= hi
      ? { [numeric.key]: Math.round(value) }
      : null;
  }
  if (name === 'set_reminders_enabled') {
    return typeof args.on === 'boolean' ? { on: args.on } : null;
  }
  if (name === 'set_reminder') {
    return /^\d{2}:\d{2}$/.test(String(args.time || '')) ? { time: args.time, action: args.action } : null;
  }
  if (NEVER_SUGGEST.has(name)) return null;
  return Object.keys(args).length ? args : {};
}

/**
 * What the app says when no engine is reachable.
 *
 * Signed as the built-in tutor, because it is. The whole feature working
 * offline matters more than it being clever: a learner with no key still gets
 * something noticed about their week.
 */
export function localNotice(state = Store.state, { due = 0, now = Date.now() } = {}) {
  const brief = learningBrief(state);
  const lines = localAdvice(brief, due).split('\n').map((l) => l.trim()).filter(Boolean);
  // The headline is on Home already; the sentence after it is the observation.
  const text = lines.find((l) => l !== headline(brief, due)) || lines[0];
  return validate({ kind: 'observation', text },
    { engine: 'Built-in tutor', saw: digest(state, { due }), now });
}

/** Add a note to the log, keeping it short. */
export function remember(note) {
  if (!note) return;
  Store.commit((s) => {
    s.notices = [...(s.notices || []), note].slice(-KEEP);
  });
}

/** Mark what became of one. */
export function settle(id, state, extra = {}) {
  Store.commit((s) => {
    s.notices = (s.notices || []).map((n) => (n.id === id ? { ...n, state, ...extra } : n));
  });
}

/**
 * The one on screen, if any.
 *
 * `done` counts as still on screen: a suggestion that was just accepted has
 * to stay long enough to be taken back. It is the learner who closes it, not
 * the act of agreeing to it.
 */
export function open(state = Store.state) {
  const log = state.notices || [];
  const last = log[log.length - 1];
  return last && (last.state === 'open' || last.state === 'done') ? last : null;
}
