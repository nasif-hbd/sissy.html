/**
 * Spaced repetition — an SM-2 variant with short learning steps.
 *
 * Pure functions only: they take a scheduling record and return a new one, so
 * the scheduler can be unit-tested and swapped (FSRS, Leitner, …) without
 * touching the UI. Grades are 0 Again · 1 Hard · 2 Good · 3 Easy.
 */
import { SRS } from './config.js';

const MIN = 60_000;
const DAY = 86_400_000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** ±fuzz% jitter so cards learned together don't come back together forever. */
function fuzzed(days) {
  const spread = days * SRS.fuzz;
  return days + (Math.random() * 2 - 1) * spread;
}

/**
 * Apply a grade to a scheduling record.
 * @returns {object} a new record — the input is not mutated.
 */
export function schedule(rec, grade, now = Date.now()) {
  const r = { ...rec };
  const steps = SRS.learningSteps;

  r.reps += 1;
  r.lastReviewed = now;
  r.lastGrade = grade;

  if (r.state === 'new' || r.state === 'learning') {
    if (grade === 0) {
      r.state = 'learning';
      r.step = 0;
      r.due = now + steps[0] * MIN;
    } else if (grade === 1) {
      r.state = 'learning';
      r.step = Math.min(r.step, steps.length - 1);
      r.due = now + steps[r.step] * MIN;
    } else if (grade === 2) {
      const next = r.step + 1;
      if (next >= steps.length) {
        r.state = 'review';
        r.step = 0;
        r.interval = SRS.graduatingInterval;
        r.due = now + r.interval * DAY;
      } else {
        r.state = 'learning';
        r.step = next;
        r.due = now + steps[next] * MIN;
      }
    } else {
      r.state = 'review';
      r.step = 0;
      r.interval = SRS.easyInterval;
      r.due = now + r.interval * DAY;
    }
    return r;
  }

  // ── review cards ────────────────────────────────────────────────────────
  if (grade === 0) {
    r.lapses += 1;
    r.ease = clamp(r.ease + SRS.easeDelta.again, SRS.minEase, 3.5);
    r.interval = Math.max(1, Math.round(r.interval * SRS.lapseFactor));
    r.state = 'learning';
    r.step = 0;
    r.due = now + steps[0] * MIN;
    return r;
  }

  const key = grade === 1 ? 'hard' : grade === 2 ? 'good' : 'easy';
  r.ease = clamp(r.ease + SRS.easeDelta[key], SRS.minEase, 3.5);
  const factor = grade === 1 ? SRS.hardFactor : grade === 2 ? r.ease : r.ease * SRS.easyBonus;
  const base = Math.max(1, r.interval || 1) * factor;
  r.interval = clamp(Math.round(fuzzed(base)), 1, SRS.maxInterval);
  r.due = now + r.interval * DAY;
  return r;
}

/** What each of the four buttons would do — used to label them. */
export function previewIntervals(rec, now = Date.now()) {
  const out = {};
  for (const [name, grade] of [['again', 0], ['hard', 1], ['good', 2], ['easy', 3]]) {
    const next = schedule(rec, grade, now);
    out[name] = formatDelta(next.due - now);
  }
  return out;
}

export function formatDelta(ms) {
  if (ms <= 0) return 'now';
  const mins = ms / MIN;
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 31) return `${Math.round(days)}d`;
  const months = days / 30.4;
  if (months < 12) return `${Math.round(months)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function isDue(rec, now = Date.now()) {
  return !rec || rec.due <= now;
}

/** Display bucket for a card — drives the dots, filters and mastery chart. */
export function bucket(rec) {
  if (!rec || rec.state === 'new') return 'new';
  if (rec.lapses >= SRS.leechThreshold) return 'leech';
  if (rec.state === 'learning') return 'learning';
  if (rec.interval >= SRS.masteredInterval) return 'mastered';
  return 'review';
}

/**
 * Build today's study queue.
 *
 * Order: overdue reviews first (most overdue first), then learning cards that
 * have come round again, then up to `newAllowance` unseen cards.
 */
export function buildQueue(state, { now = Date.now(), newAllowance = 10, ahead = false } = {}) {
  const due = [];
  const learning = [];
  const fresh = [];

  for (const id of Object.keys(state.words)) {
    const rec = state.srs[id];
    if (!rec) continue;
    if (rec.state === 'new') { fresh.push(id); continue; }
    if (rec.due > now && !ahead) continue;
    (rec.state === 'learning' ? learning : due).push(id);
  }

  due.sort((a, b) => state.srs[a].due - state.srs[b].due);
  learning.sort((a, b) => state.srs[a].due - state.srs[b].due);
  fresh.sort((a, b) => (state.words[a].addedAt || 0) - (state.words[b].addedAt || 0));

  return [...due, ...learning, ...fresh.slice(0, Math.max(0, newAllowance))];
}

/** Counts for the three chips above the flashcard. */
export function queueCounts(state, now = Date.now()) {
  let due = 0, learning = 0, fresh = 0;
  for (const id of Object.keys(state.words)) {
    const rec = state.srs[id];
    if (!rec) continue;
    if (rec.state === 'new') fresh++;
    else if (rec.due <= now) (rec.state === 'learning' ? learning++ : due++);
  }
  return { due, learning, new: fresh };
}

/**
 * What a session started right now would actually serve.
 *
 * `queueCounts` reports the whole deck — every new card in it, however many
 * days' worth that is. `buildQueue` then hands over only `newAllowance` of
 * them. Anything user-facing that promises a number has to use this one, or it
 * over-promises: a fresh 40-word deck offered "Learn 40 new words" and then
 * gave the learner ten.
 */
export function plannedSession(state, { now = Date.now(), newAllowance = 10 } = {}) {
  const counts = queueCounts(state, now);
  const fresh = Math.max(0, Math.min(counts.new, newAllowance));
  return {
    due: counts.due,
    learning: counts.learning,
    new: fresh,
    /** New cards in the deck that today's allowance will not reach. */
    heldBack: counts.new - fresh,
    total: counts.due + counts.learning + fresh,
  };
}

/** Cards coming back over the next `days` days, bucketed per day. */
export function forecast(state, days = 7, now = Date.now()) {
  const out = Array.from({ length: days }, () => 0);
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  for (const rec of Object.values(state.srs)) {
    if (rec.state === 'new') continue;
    const idx = Math.floor((rec.due - startOfToday.getTime()) / DAY);
    if (idx >= 0 && idx < days) out[idx] += 1;
    else if (idx < 0) out[0] += 1; // already overdue → today's column
  }
  return out;
}
