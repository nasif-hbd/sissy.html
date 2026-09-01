/**
 * Tracking — everything the Progress tab draws, plus the numbers the AI report
 * is given. All functions are pure reads over `Store.state`.
 */
import { dayKey, daysAgoKey } from './store.js';
import { bucket } from './srs.js';

const DAY = 86_400_000;

export function dayStats(state, key) {
  return state.days[key] || { reviews: 0, correct: 0, learned: 0, seconds: 0 };
}

/** Rolling window totals over the last `n` days, today included. */
export function window(state, n = 7) {
  let reviews = 0, correct = 0, learned = 0, seconds = 0, activeDays = 0;
  for (let i = 0; i < n; i++) {
    const d = dayStats(state, daysAgoKey(i));
    reviews += d.reviews; correct += d.correct; learned += d.learned; seconds += d.seconds;
    if (d.reviews > 0) activeDays++;
  }
  return { reviews, correct, learned, seconds, activeDays,
           accuracy: reviews ? correct / reviews : null };
}

export function summary(state) {
  const w7 = window(state, 7);
  const ids = Object.keys(state.words);
  /* Two different counts, and the difference matters on screen. `studied` is
     every word the learner has actually met — it moves the first time a card
     is graded. `known` is the ones that have graduated to long-term review,
     which takes days, so it is the wrong number to put behind a tile that is
     supposed to reward turning up. */
  let known = 0, studied = 0;
  for (const id of ids) {
    const state_ = bucket(state.srs[id]);
    if (state_ !== 'new') studied += 1;
    if (state_ === 'review' || state_ === 'mastered') known += 1;
  }
  const today = dayStats(state, dayKey());
  return {
    total: ids.length,
    known,
    studied,
    today,
    streak: state.streak.current || 0,
    longest: state.streak.longest || 0,
    reviews7: w7.reviews,
    perDay: Math.round(w7.reviews / 7),
    accuracy7: w7.accuracy,
    minutes7: Math.round(w7.seconds / 60),
  };
}

/** 12 weeks of daily activity, oldest first, laid out column-per-week. */
export function heatmap(state, weeks = 12) {
  const cells = [];
  const total = weeks * 7;
  // Start on the Monday that keeps `total` days ending today.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (total - 1));
  const offset = (start.getDay() + 6) % 7; // Monday = 0
  start.setDate(start.getDate() - offset);

  const cursor = new Date(start);
  const todayKey = dayKey();
  while (true) {
    const key = dayKey(cursor);
    const count = dayStats(state, key).reviews;
    cells.push({ key, count, level: level(count), future: key > todayKey });
    if (key === todayKey) break;
    cursor.setDate(cursor.getDate() + 1);
    if (cells.length > 400) break; // safety
  }
  return cells;
}

function level(count) {
  if (!count) return 0;
  if (count < 10) return 1;
  if (count < 25) return 2;
  if (count < 50) return 3;
  return 4;
}

/** Last `n` days as bars, oldest first. */
export function recentDays(state, n = 14) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = daysAgoKey(i);
    const d = dayStats(state, key);
    out.push({
      key,
      label: new Date(key + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'narrow' }),
      reviews: d.reviews,
      correct: d.correct,
    });
  }
  return out;
}

/**
 * The four numbers the dashboard puts across the top, unformatted.
 *
 * Every one of them starts at zero on a new install and moves only when work
 * is done — none of them counts anything the app handed the learner.
 *
 *   words    words actually met, not the size of the deck a new install was
 *            seeded with. It moves on the first card graded, where the
 *            graduated-only count sits at zero for days.
 *   mastery  of those, the share that has graduated to long-term review — so
 *            the pair reads "8 studied, 0% of them stuck yet" and both halves
 *            move for their own reason. A share of every word in every pack
 *            would read 0% for months and measure how big the library is.
 *   days     days actually studied, not days since the install, so a
 *            fortnight away moves nothing.
 */
export function dashboard(state) {
  const mix = masteryBreakdown(state);
  const started = mix.learning + mix.review + mix.mastered + mix.leech;
  return {
    words: started,
    // Nothing started is nothing mastered — a real zero, not a missing value.
    mastery: started ? (mix.review + mix.mastered) / started : 0,
    streak: state.streak?.current || 0,
    seconds: dayStats(state, dayKey()).seconds || 0,
    days: activeDays(state),
  };
}

/** Days with at least one review on them, over the whole history. */
export function activeDays(state) {
  let n = 0;
  for (const day of Object.values(state.days || {})) if (day.reviews > 0) n += 1;
  return n;
}

/**
 * The last `n` distinct words the learner met, newest first, with where each
 * one stands now. Reads the review log backwards, so a word reviewed twice
 * appears once, at its most recent sighting.
 */
export function recentlyLearned(state, n = 6) {
  const out = [];
  const seen = new Set();
  for (let i = state.history.length - 1; i >= 0 && out.length < n; i--) {
    const id = state.history[i].wordId;
    if (seen.has(id)) continue;
    seen.add(id);
    const word = state.words[id];
    if (!word) continue;            // a word deleted since it was reviewed
    out.push({
      id,
      term: word.term,
      definition: word.definition || '',
      level: word.level || '',
      state: bucket(state.srs[id]),
    });
  }
  return out;
}

export function masteryBreakdown(state) {
  const counts = { new: 0, learning: 0, review: 0, mastered: 0, leech: 0 };
  for (const id of Object.keys(state.words)) counts[bucket(state.srs[id])] += 1;
  return counts;
}

/**
 * Words the learner keeps getting wrong — the signal the AI report and the
 * word suggester are given, and what the "Struggling" filter shows.
 */
export function weakest(state, n = 8) {
  const score = new Map();
  for (const h of state.history.slice(-600)) {
    const s = score.get(h.wordId) || { wrong: 0, seen: 0 };
    s.seen += 1;
    if (!h.correct) s.wrong += 1;
    score.set(h.wordId, s);
  }
  return [...score.entries()]
    .filter(([id, s]) => state.words[id] && s.wrong > 0)
    .map(([id, s]) => ({
      id,
      term: state.words[id].term,
      wrong: s.wrong,
      seen: s.seen,
      lapses: state.srs[id]?.lapses || 0,
      rate: s.wrong / s.seen,
    }))
    .sort((a, b) => (b.wrong + b.lapses) - (a.wrong + a.lapses) || b.rate - a.rate)
    .slice(0, n);
}

/** Compact snapshot handed to Claude for the weekly report. */
export function reportPayload(state) {
  const s = summary(state);
  return {
    level: state.profile.level,
    streak: s.streak,
    longestStreak: s.longest,
    deckSize: s.total,
    knownWords: s.known,
    reviewsLast7Days: s.reviews7,
    accuracyLast7Days: s.accuracy7 == null ? null : Math.round(s.accuracy7 * 100),
    minutesLast7Days: s.minutes7,
    dailyGoal: state.settings.dailyGoal,
    activeDaysLast7: window(state, 7).activeDays,
    mastery: masteryBreakdown(state),
    strugglingWords: weakest(state, 6).map((w) => ({ term: w.term, wrong: w.wrong, seen: w.seen })),
    recentlyLearned: Object.values(state.words)
      .filter((w) => Date.now() - w.addedAt < 7 * DAY)
      .slice(-10)
      .map((w) => w.term),
  };
}

/** Wall-clock timer for "minutes studied"; pauses when the tab is hidden. */
export function makeSessionTimer(onTick) {
  let start = null;
  return {
    resume() { if (start === null && document.visibilityState === 'visible') start = Date.now(); },
    flush() {
      if (start === null) return 0;
      const seconds = Math.round((Date.now() - start) / 1000);
      start = null;
      if (seconds > 0 && seconds < 3600) onTick(seconds);
      return seconds;
    },
  };
}
