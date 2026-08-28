/**
 * Your routine — a day built out of steps at exact times.
 *
 * The app used to hold a flat list of reminder times and show the same nag at
 * each one. A routine is that list with intent attached: *what* happens at
 * 07:30 is a different thing from what happens at 21:00, and the notification
 * should say so.
 *
 * Two of the step types exist to put English on a lock screen. A web app cannot
 * draw a lock-screen widget on any platform — that needs a native app — but a
 * notification lands on the lock screen on Android and iOS and in the
 * notification centre on Windows and macOS, and a notification carrying a word
 * and its meaning does the job a widget would.
 *
 * Everything here is pure so the schedule can be tested without a browser: a
 * reminder that fires twice, or at the wrong hour, or silently never, is
 * exactly the class of bug that hides until someone's morning is interrupted.
 */

/** What a step can do, in the order the picker offers them. */
export const ACTIONS = {
  review: {
    label: 'Review what is due',
    hint: 'The words the scheduler says are ready',
    view: 'learn',
    icon: 'i-study',
  },
  module: {
    label: 'Carry on a module',
    hint: 'The next set of ten in whatever you are working through',
    view: 'modules',
    icon: 'i-modules',
  },
  practice: {
    label: 'Practise',
    hint: 'A quiz, a spelling drill, or write a sentence',
    view: 'practice',
    icon: 'i-drill',
  },
  word: {
    label: 'A word on the lock screen',
    hint: 'One word and its meaning, no app to open',
    view: 'learn',
    icon: 'i-bulb',
    passive: true,
  },
  quote: {
    label: 'A line to keep going',
    hint: 'A short push, on the lock screen',
    view: 'home',
    icon: 'i-flame',
    passive: true,
  },
  surprise: {
    label: 'Surprise me',
    hint: 'A different kind of card each time — a word, a translation, a question, a fact',
    // Unlike the others this has no fixed destination: a word card opens Learn,
    // a quote opens Home. `view` here is only the fallback; the card decides.
    view: 'home',
    varies: true,
    icon: 'i-compass',
    passive: true,
  },
};

/**
 * The kinds a "surprise" step can turn into.
 *
 * Two card types was not variety — the same two things at the same two times
 * every day stops being read. These rotate, and any kind that has nothing to
 * show for the word it drew falls through to the next rather than firing a
 * card with a hole in it.
 */
export const SURPRISE_KINDS = ['word', 'translation', 'synonym', 'question', 'fact', 'quote'];

/** A sensible day, offered on first use. */
export const DEFAULT_ROUTINE = [
  { time: '08:00', action: 'surprise' },
  { time: '13:00', action: 'review' },
  { time: '21:00', action: 'module' },
];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const validTime = (t) => HHMM.test(String(t || ''));
export const minutesOf = (t) => {
  const m = HHMM.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** A step id that survives editing the time — the fired-today record keys on it. */
let seq = 0;
export const makeStep = (time = '09:00', action = 'review') => ({
  id: `s${Date.now().toString(36)}${(seq += 1).toString(36)}`,
  time,
  action: ACTIONS[action] ? action : 'review',
});

/**
 * Older saves hold `reminders.times`, a bare list of "HH:MM". Turn it into a
 * routine rather than dropping the times someone already chose.
 */
export function fromTimes(times = []) {
  const steps = times.filter(validTime).map((t, i) => ({
    id: `migrated-${t.replace(':', '')}`,
    time: t,
    // A morning slot is a nudge to start; a later one is a review.
    action: minutesOf(t) < 11 * 60 ? 'surprise' : 'review',
  }));
  return sortRoutine(steps);
}

export const sortRoutine = (steps) =>
  [...steps].sort((a, b) => (minutesOf(a.time) ?? 0) - (minutesOf(b.time) ?? 0));

/**
 * Which step is due right now, if any.
 *
 * A step fires when the clock has passed its time, not more than `graceMins`
 * later (so closing the laptop for the afternoon does not produce a burst of
 * stale notifications at six o'clock), and it has not already fired today.
 * Returns the latest such step, so after a long gap you get the most recent
 * thing rather than the oldest.
 */
export function dueStep(routine, { now = new Date(), fired = {}, today = '', graceMins = 30 } = {}) {
  const nowMins = now.getHours() * 60 + now.getMinutes();
  let best = null;
  let bestMins = -1;

  for (const step of routine || []) {
    const at = minutesOf(step.time);
    if (at === null) continue;
    if (nowMins < at) continue;                 // not yet
    if (nowMins - at > graceMins) continue;     // too long past to be useful
    if (fired[step.id] === today) continue;     // already sent today
    if (at > bestMins) { best = step; bestMins = at; }
  }
  return best;
}

/** Lines shipped with the app, so the lock-screen card never needs a network. */
export const QUOTES = [
  'A word you meet twice is a word you start to own.',
  'Ten minutes today beats an hour you keep postponing.',
  'You are not bad at English. You are early in it.',
  'The word you cannot remember is the one worth the next look.',
  'Fluency is vocabulary you stopped having to think about.',
  'Small and daily wins against big and occasional.',
  'Every word you learn is a sentence you could not write yesterday.',
  'Reading is vocabulary practice that does not feel like practice.',
  'The gap between the word you know and the word you use is closed by using it.',
  'Nobody learned a language in a day. Everybody learned one a day at a time.',
];

const rotate = (list, n) => [...list.slice(n), ...list.slice(0, n)];

/**
 * One surprise card, or null when the data cannot fill it.
 *
 * Every branch returns null rather than a card with a gap in it: a
 * notification reading "resilient — undefined" is worse than no notification.
 */
function surpriseCard(kind, { word, quote, streak, pending, doneToday }) {
  if (kind === 'quote') {
    return quote ? { title: 'Lexio', body: quote, view: 'home', quiet: true } : null;
  }
  if (!word?.term) return null;

  if (kind === 'word') {
    if (!word.definition) return null;
    return {
      title: word.term,
      body: `${word.pos ? `(${word.pos}) ` : ''}${word.definition}`,
      view: 'learn', quiet: true,
    };
  }
  if (kind === 'translation') {
    const bn = word.tr?.bn;
    const hi = word.tr?.hi;
    if (!bn && !hi) return null;
    return {
      title: word.term,
      body: [bn && `Bangla: ${bn}`, hi && `Hindi: ${hi}`].filter(Boolean).join('  ·  '),
      view: 'learn', quiet: true,
    };
  }
  if (kind === 'synonym') {
    const near = (word.synonyms || []).filter(Boolean).slice(0, 3);
    if (!near.length) return null;
    return {
      title: `${word.term} ≈ ${near[0]}`,
      body: near.length > 1 ? `Also: ${near.slice(1).join(', ')}.` : (word.definition || ''),
      view: 'learn', quiet: true,
    };
  }
  if (kind === 'question') {
    if (!word.definition) return null;
    return {
      title: `What does “${word.term}” mean?`,
      body: 'Think of it, then open Lexio to check.',
      view: 'learn', quiet: true,
    };
  }
  if (kind === 'fact') {
    if (!word.pos || !word.definition) return null;
    return {
      title: word.term,
      body: `${article(word.pos)} ${word.pos}. ${USE_NOTE[word.pos.toLowerCase()] || word.definition}`,
      view: 'learn', quiet: true,
    };
  }
  return null;
}

const article = (w) => (/^[aeiou]/i.test(w) ? 'An' : 'A');

/** What each part of speech asks the reader to notice. */
const USE_NOTE = {
  verb: 'Check what it takes as an object before you use it.',
  noun: 'The article in front of it — a, the, or none — is half the battle.',
  adjective: 'Try it before a noun, and after “is”.',
  adverb: 'It usually sits next to the verb it changes.',
};

/** Deterministic pick, so the same day gives the same line rather than flicker. */
export function quoteFor(dayKey = '', list = QUOTES) {
  if (!list.length) return '';
  let hash = 0;
  for (const ch of String(dayKey)) hash = (hash * 31 + ch.charCodeAt(0)) % 100000;
  return list[hash % list.length];
}

/**
 * The notification for a step: a title and a body.
 *
 * `ctx` carries what the app knows — due counts, the module in progress, a word
 * to show. Kept separate from the step so this stays pure.
 */
export function cardFor(step, ctx = {}) {
  const { due = 0, learning = 0, fresh = 0, doneToday = 0, dailyGoal = 0,
          moduleTitle = '', setNumber = 0, word = null, quote = '',
          streak = 0, pick = Math.random } = ctx;
  const pending = due + learning;

  // A surprise step becomes one of the passive kinds, chosen at fire time.
  if (step.action === 'surprise') {
    const order = rotate(SURPRISE_KINDS, Math.floor(pick() * SURPRISE_KINDS.length));
    for (const kind of order) {
      const card = surpriseCard(kind, { word, quote, streak, pending, doneToday });
      if (card) return card;
    }
    return null;
  }

  switch (step.action) {
    case 'word':
      if (!word?.term) return null;
      return {
        title: word.term,
        body: word.definition
          ? `${word.pos ? `(${word.pos}) ` : ''}${word.definition}`
          : 'Open Lexio to see the meaning.',
        view: 'learn',
        quiet: true,
      };

    case 'quote':
      if (!quote) return null;
      return { title: 'Lexio', body: quote, view: 'home', quiet: true };

    case 'module':
      if (!moduleTitle) {
        return { title: 'Pick a module', body: 'Ten words at a time, then a short exam.', view: 'modules' };
      }
      return {
        title: `${moduleTitle} — set ${setNumber || 1}`,
        body: 'Ten words and a short exam. About five minutes.',
        view: 'modules',
      };

    case 'practice':
      return {
        title: 'Two minutes of practice',
        body: 'A quiz, a spelling drill, or write one sentence and have it marked.',
        view: 'practice',
      };

    case 'review':
    default:
      if (pending > 0) {
        return {
          title: `${pending} word${pending === 1 ? '' : 's'} ready to review`,
          body: doneToday > 0
            ? `${doneToday} done today — a few more and the day is banked.`
            : 'Two minutes now keeps the streak alive.',
          view: 'learn',
        };
      }
      if (fresh > 0) {
        return {
          title: `${fresh} new word${fresh === 1 ? '' : 's'} waiting`,
          body: 'Nothing is due, so this is all new ground.',
          view: 'learn',
        };
      }
      if (dailyGoal && doneToday >= dailyGoal) return null;  // nothing worth interrupting for
      return {
        title: 'Keep the streak going',
        body: `${doneToday} of ${dailyGoal} reviews today.`,
        view: 'learn',
      };
  }
}
