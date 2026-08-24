/**
 * Experience points and levels.
 *
 * Every action worth repeating pays, and the amounts are set so that the
 * habit the app is trying to build — a short session every day — pays better
 * than a long one once a week. Getting an answer wrong still pays a little:
 * the point is to keep people turning cards, not to punish them for the
 * exact thing they came here to fix.
 */
import { Store, dayKey } from './store.js';

/** What each action is worth. The whole economy is this object. */
export const AWARDS = {
  reviewCorrect: 10,
  reviewWrong: 3,
  wordLearned: 15,      // a new card graduating out of "new"
  quizCorrect: 8,
  spellCorrect: 12,
  sentenceCoached: 20,  // writing costs the most effort, so it pays the most
  goalMet: 50,          // once a day
  streakDay: 5,         // × the streak, capped, once a day
  streakCap: 10,
  moduleFinished: 200,
};

/** Level L costs this much to leave. Gentle at first, then steady. */
const cost = (level) => 100 + (level - 1) * 60;

/**
 * Where a given XP total sits.
 * @returns {{level:number, into:number, need:number, pct:number, title:string}}
 */
export function standing(xp = 0) {
  let level = 1;
  let into = Math.max(0, Math.round(xp));
  let need = cost(level);
  while (into >= need) { into -= need; level += 1; need = cost(level); }
  return { level, into, need, pct: need ? into / need : 0, title: titleFor(level) };
}

const TITLES = [
  [1, 'Beginner'], [3, 'Learner'], [6, 'Reader'], [10, 'Scholar'],
  [15, 'Linguist'], [22, 'Wordsmith'], [30, 'Lexicographer'],
];
function titleFor(level) {
  let title = TITLES[0][1];
  for (const [from, name] of TITLES) if (level >= from) title = name;
  return title;
}

/** Total XP needed to reach a level — used by the tests and the next-level line. */
export function xpForLevel(level) {
  let total = 0;
  for (let l = 1; l < level; l += 1) total += cost(l);
  return total;
}

/**
 * Award XP and record where it came from, so the leaderboard can rank days and
 * modules without a second ledger.
 */
export function award(amount, { module: moduleId } = {}) {
  const points = Math.round(amount);
  if (points <= 0) return 0;

  Store.commit((state) => {
    const xp = (state.xp ??= { total: 0, byDay: {}, byModule: {} });
    xp.total = (xp.total || 0) + points;
    const key = dayKey();
    xp.byDay[key] = (xp.byDay[key] || 0) + points;
    if (moduleId) xp.byModule[moduleId] = (xp.byModule[moduleId] || 0) + points;
  });
  return points;
}

/** The once-a-day awards, claimed the first time they become true. */
export function claimDailyBonuses() {
  const state = Store.state;
  const key = dayKey();
  if (!state.xp) state.xp = { total: 0, byDay: {}, byModule: {} };
  const claimed = (state.xp.claimed ||= {});
  let won = 0;

  if (!claimed[`goal:${key}`] && (state.days[key]?.reviews || 0) >= state.settings.dailyGoal) {
    claimed[`goal:${key}`] = true;
    won += award(AWARDS.goalMet);
  }
  const streak = state.streak.current || 0;
  if (streak > 0 && !claimed[`streak:${key}`]) {
    claimed[`streak:${key}`] = true;
    won += award(AWARDS.streakDay * Math.min(streak, AWARDS.streakCap));
  }
  if (won) Store.save();
  return won;
}

/** Modules ranked by the XP earned inside them, best first. */
export function moduleStandings(state, manifest = []) {
  const byModule = state.xp?.byModule || {};
  const titles = new Map(manifest.map((m) => [m.id, m.title]));
  const counts = {};
  for (const word of Object.values(state.words)) {
    if (word.module) counts[word.module] = (counts[word.module] || 0) + 1;
  }
  return Object.keys({ ...byModule, ...counts })
    .map((id) => ({ id, title: titles.get(id) || id, xp: byModule[id] || 0, words: counts[id] || 0 }))
    .sort((a, b) => b.xp - a.xp || b.words - a.words);
}

/** The learner's best days, best first. */
export function bestDays(state, limit = 5) {
  return Object.entries(state.xp?.byDay || {})
    .map(([day, xp]) => ({ day, xp }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, limit);
}
