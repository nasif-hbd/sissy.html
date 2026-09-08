/**
 * What the assistant knows about you.
 *
 * The assistant is only useful if it can see the work. "How am I doing?" has
 * no answer without the numbers, and "what should I study now?" without them
 * is a horoscope. So every question carries a compact, factual snapshot of the
 * learner's own state alongside it.
 *
 * Two rules shape what goes in. It is *derived*, never raw: counts, rates and
 * a handful of terms, not the history log — a snapshot that fits in a few
 * hundred characters costs nothing to send and cannot leak what it does not
 * contain. And it is *honest about being empty*: a brand-new account has no
 * numbers, and the assistant should say so rather than invent a trend from
 * three reviews.
 */
import { summary, weakest, recentlyLearned, masteryBreakdown } from './stats.js';

/** Below this, there is not enough work behind the numbers to read anything into. */
export const ENOUGH = 20;

/**
 * The snapshot, as data.
 *
 * Kept separate from the sentence so the screen can show the same facts the
 * assistant is given — nobody should have to trust a summary of their own
 * progress that they cannot check.
 */
export function learningBrief(state) {
  const s = summary(state);
  const weak = weakest(state, 6).map((w) => w.term);
  const recent = recentlyLearned(state, 5).map((w) => w.term);
  const mastery = masteryBreakdown(state);

  return {
    words: s.total,
    studied: s.studied,
    known: s.known,
    streak: s.streak,
    longest: s.longest,
    todayReviews: s.today?.reviews || 0,
    todayMinutes: Math.round((s.today?.seconds || 0) / 60),
    reviews7: s.reviews7,
    perDay: s.perDay,
    accuracy7: s.accuracy7,
    minutes7: s.minutes7,
    mastery,
    weakest: weak,
    recent,
    /* The assistant is told when the numbers are too thin to read, so it can
       say "too early to tell" instead of finding a pattern in noise. */
    enough: s.reviews7 >= ENOUGH,
  };
}

/**
 * The same snapshot as a line of prose, for the model.
 *
 * Written as flat statements rather than JSON because it is read, not parsed,
 * and a sentence survives a model that ignores structure.
 */
export function briefText(brief) {
  const parts = [];
  parts.push(`${brief.studied} of ${brief.words} words started, ${brief.known} in long-term review.`);
  parts.push(brief.streak > 0
    ? `Streak ${brief.streak} day${brief.streak === 1 ? '' : 's'} (best ${brief.longest}).`
    : 'No streak running.');
  parts.push(brief.todayReviews
    ? `Today: ${brief.todayReviews} reviews, ${brief.todayMinutes} minutes.`
    : 'Nothing studied today yet.');

  if (brief.reviews7) {
    parts.push(`Last 7 days: ${brief.reviews7} reviews, about ${brief.perDay} a day, `
      + `${Math.round(brief.accuracy7 * 100)}% correct, ${brief.minutes7} minutes.`);
  } else {
    parts.push('Nothing studied in the last 7 days.');
  }

  if (brief.weakest.length) parts.push(`Weakest words: ${brief.weakest.join(', ')}.`);
  if (brief.recent.length) parts.push(`Recently learned: ${brief.recent.join(', ')}.`);
  if (!brief.enough) {
    parts.push('There is not much history yet — say so rather than reading a trend into it.');
  }
  return parts.join(' ');
}

/**
 * The one thing worth saying without asking a model at all.
 *
 * The sheet opens with this on screen instantly, offline, before any request
 * leaves the device. A panel that says "thinking…" for two seconds to tell
 * someone they have 12 reviews due is a worse panel than one that just says
 * it, and this is also what the app falls back to when nothing is reachable.
 */
export function headline(brief, due = 0) {
  if (due > 0) {
    return `${due} card${due === 1 ? '' : 's'} due right now`
      + (brief.todayReviews ? ` — ${brief.todayReviews} done today.` : '.');
  }
  if (brief.todayReviews) {
    return `Nothing due. ${brief.todayReviews} review${brief.todayReviews === 1 ? '' : 's'} done today`
      + (brief.todayMinutes ? `, ${brief.todayMinutes} minutes.` : '.');
  }
  if (brief.studied === 0) return 'Nothing studied yet — start anywhere and this fills in.';
  return 'Nothing due today. A good day to learn new words.';
}

/**
 * What to offer when there is no question yet.
 *
 * The prompts change with the state they are offered in: someone with a
 * backlog and someone with an empty queue need different first moves, and a
 * fixed list would show "why do I keep forgetting these?" to a learner who
 * has not forgotten anything yet.
 */
export function prompts(brief, due = 0) {
  const out = [];
  if (due > 0) out.push({ label: 'What should I do right now?', ask: 'What should I study right now, and for how long?' });
  else out.push({ label: 'What should I learn next?', ask: 'Nothing is due. What should I learn next, and why?' });

  if (brief.weakest.length) {
    out.push({
      label: 'Why do these keep slipping?',
      ask: `I keep getting these wrong: ${brief.weakest.join(', ')}. Why might that be, and what should I do about it?`,
    });
  }
  if (brief.reviews7) out.push({ label: 'How am I doing?', ask: 'Read my progress and tell me honestly how it is going.' });
  out.push({ label: 'Plan my week', ask: 'Give me a realistic plan for the next seven days based on my numbers.' });
  return out.slice(0, 4);
}

/**
 * The answer when nothing is reachable.
 *
 * The generic offline tutor knows about words, not about you — asked "how am
 * I doing", it says it needs a live engine, which is a poor answer to a
 * question the app can answer from its own numbers. So progress questions get
 * answered here instead: no model, no network, and nothing invented that the
 * snapshot does not already say.
 */
export function localAdvice(brief, due = 0) {
  const lines = [headline(brief, due)];

  if (due > 0) {
    const minutes = Math.max(2, Math.round(due * 0.15));
    lines.push(`Clearing them takes roughly ${minutes} minute${minutes === 1 ? '' : 's'}. `
      + 'Reviews first, new words after — a word you already half-know is cheaper to keep '
      + 'than a new one is to learn.');
  } else if (brief.studied === 0) {
    lines.push('Start with one pack and one short session. Ten new words is a real day\u2019s work; '
      + 'the schedule will bring them back before you forget them.');
  } else {
    lines.push('Nothing is due, so this is the day to add new words rather than repeat old ones.');
  }

  if (brief.weakest.length) {
    lines.push(`These are costing you the most: ${brief.weakest.slice(0, 4).join(', ')}. `
      + 'A word that keeps lapsing usually needs a sentence you actually care about, not another repetition.');
  }

  if (!brief.enough) {
    lines.push('There is not enough history yet to say anything about your trend — '
      + 'come back after a week of study and the numbers will mean something.');
  } else {
    const pct = Math.round(brief.accuracy7 * 100);
    lines.push(pct >= 90
      ? `${pct}% correct over the week is high enough that you can afford more new words per day.`
      : pct >= 75
        ? `${pct}% correct over the week is the right range — hard enough to be learning, not so hard it stalls.`
        : `${pct}% correct over the week is low. Fewer new words for a few days lets the backlog settle.`);
  }

  lines.push('\u2014 answered on this device; no engine was reachable.');
  return lines.join('\n\n');
}
