/**
 * What to do about the result.
 *
 * The placement exam produces a level; this turns it into a plan the learner
 * can act on in one tap — which modules to open, how many new words a day is
 * realistic, and what in their own deck needs attention.
 *
 * Deliberately deterministic. Claude writes the explanation around it (see
 * localAssess/the assess route), but the numbers and the module ranking are
 * computed here so the whole feature still works with no key and no server, and
 * so it can be tested.
 */
import { BANDS } from './placement.js';

/** CEFR order, for comparing a module's range against a learner's level. */
const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
export const cefrIndex = (l) => Math.max(0, CEFR.indexOf(l));

/**
 * How many new words a day this learner can absorb.
 *
 * Accuracy is the signal: someone getting most reviews right has headroom;
 * someone under 70% is already carrying more than they can hold, and adding
 * more new words makes tomorrow worse.
 */
export function pace(accuracy, current = 10, placement = null) {
  if (accuracy == null) return fromPlacement(placement, current);
  if (accuracy >= 0.9) return { newPerDay: 15, dailyGoal: 30, why: `You are getting ${pct(accuracy)} of reviews right, so there is room for more new words.` };
  if (accuracy >= 0.75) return { newPerDay: 10, dailyGoal: 25, why: `${pct(accuracy)} accuracy is a healthy working range — hold this pace.` };
  if (accuracy >= 0.6) return { newPerDay: 6, dailyGoal: 20, why: `At ${pct(accuracy)} the words you have are not settling yet. Fewer new ones, same review load.` };
  return { newPerDay: 3, dailyGoal: 15, why: `${pct(accuracy)} accuracy means the deck is ahead of you. Slow the new words right down until it settles.` };
}

const pct = (n) => `${Math.round(n * 100)}%`;

/**
 * A pace for someone with no review history — their first day in the app.
 *
 * Their exam accuracy is *not* the signal to use: an adaptive exam pushes every
 * learner towards the difficulty they get about half right, so a strong and a
 * weak learner both finish near 50% and using that would tell everyone to slow
 * down. What the exam does say reliably is whether it found a band they hold at
 * all, and how high.
 */
function fromPlacement(placement, current) {
  if (!placement) return { newPerDay: current, dailyGoal: 20, why: 'No review history yet — starting where your settings already are.' };
  if (!placement.reached) {
    return { newPerDay: 5, dailyGoal: 15, why: 'The check did not find a level you hold yet, so this starts small. A short daily habit beats a long one you drop.' };
  }
  const high = placement.bandIndex >= 2;
  return high
    ? { newPerDay: 12, dailyGoal: 25, why: `You held ${placement.level} words in the check, so you can carry a full load from the start.` }
    : { newPerDay: 8, dailyGoal: 20, why: `A steady start for ${placement.level}. Once a week of reviews shows your accuracy, this adjusts to it.` };
}

/**
 * Rank the modules for this learner.
 *
 * The best module is the one pitched just above where they are: mostly words at
 * their level with a minority above it. A module that is all easier than them
 * teaches nothing; one that is all harder is discouraging. `fit` is the share
 * of the module sitting in the useful window, and the ranking is by that.
 */
export function rankModules(estimate, manifest, bandMix = {}) {
  const at = estimate.bandIndex;
  const rows = manifest.map((module) => {
    const mix = bandMix[module.id];
    const share = mix ? bandShare(mix) : evenShare();
    // Words one band above the learner are the ones worth studying; words at
    // their band consolidate; words below are revision.
    const stretch = share[at + 1] || 0;
    const level = share[at] || 0;
    const below = share.slice(0, at).reduce((a, b) => a + b, 0);
    const above = share.slice(at + 2).reduce((a, b) => a + b, 0);
    const fit = level * 0.6 + stretch * 1.0 - below * 0.35 - above * 0.5;
    return { ...module, fit, share, at: level, stretch, below, above };
  });

  rows.sort((a, b) => b.fit - a.fit);
  return rows.map((row, i) => ({ ...row, why: moduleReason(row, i) }));
}

function moduleReason(row, rank) {
  if (row.stretch >= 0.3) return `${Math.round(row.stretch * 100)}% of it sits just above your level — the stretch that moves you up.`;
  if (row.at >= 0.4) return `Mostly words at your level: use it to make what you half-know solid.`;
  if (row.above >= 0.5) return `Harder than where you are now. Worth coming back to.`;
  if (row.below >= 0.5) return `Easier than your level — quick wins and a streak, not new ground.`;
  return rank === 0 ? 'The closest fit to your level.' : 'A reasonable fit.';
}

const bandShare = (mix) => {
  const total = BANDS.reduce((sum, b) => sum + (mix[b.id] || 0), 0) || 1;
  return BANDS.map((b) => (mix[b.id] || 0) / total);
};
const evenShare = () => BANDS.map(() => 1 / BANDS.length);

/**
 * The whole plan: level, pace, the three modules to start with, and what to
 * revisit. `weak` is the learner's own struggling words from stats.weakest.
 */
export function buildPlan({ estimate, manifest = [], bandMix = {}, accuracy = null, weak = [], current = {} }) {
  const modules = rankModules(estimate, manifest, bandMix).slice(0, 3);
  const speed = pace(accuracy, current.newPerDay, estimate);

  const notes = [];
  if (!estimate.reached) {
    notes.push('The exam did not find a band you hold reliably, so this starts you at the easiest one. Retake it after a week of study.');
  }
  if (estimate.confidence === 'rough') {
    notes.push('Only one band got enough questions to judge, so treat the level as provisional.');
  }
  if (weak.length) {
    notes.push(`${weak.length} word${weak.length === 1 ? '' : 's'} in your deck keep coming back wrong. They are worth a slower look than the schedule gives them.`);
  }

  return {
    level: estimate.level,
    newPerDay: speed.newPerDay,
    dailyGoal: speed.dailyGoal,
    paceWhy: speed.why,
    modules,
    revisit: weak.slice(0, 6).map((w) => w.term),
    notes,
    changes: changeList(current, { level: estimate.level, ...speed }),
  };
}

/** What applying the plan would actually change, so the button can say so. */
function changeList(current, next) {
  const out = [];
  if (current.level && current.level !== next.level) out.push(`level ${current.level} → ${next.level}`);
  if (current.newPerDay != null && current.newPerDay !== next.newPerDay) out.push(`new words ${current.newPerDay} → ${next.newPerDay}`);
  if (current.dailyGoal != null && current.dailyGoal !== next.dailyGoal) out.push(`daily goal ${current.dailyGoal} → ${next.dailyGoal}`);
  return out;
}
