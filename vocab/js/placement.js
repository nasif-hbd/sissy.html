/**
 * The placement exam — working out what the learner can actually do.
 *
 * The learner used to pick their own CEFR level from a dropdown in Settings,
 * which is a guess dressed up as a setting: it decides how hard every
 * suggestion and definition is, and nobody knows their own level. This measures
 * it instead.
 *
 * The measurement rests on the dataset's own difficulty bands. Every word in
 * the module packs carries one (Easy / Moderate / Advanced / God Level), so a
 * question drawn from a band is a question of known difficulty. The exam walks
 * up and down those bands — right answer, harder band; wrong answer, easier —
 * and the estimate is the highest band the learner holds at a passing rate.
 *
 * The one property that makes the whole thing valid: **distractors come from
 * the same band as the answer**. Mixing bands would make a "God Level" item
 * answerable by elimination against three easy words, and the ladder would
 * measure nothing. There is a test for exactly that.
 */

/** The dataset's bands, easiest first, with the CEFR level each stands for. */
export const BANDS = [
  { id: 'Easy', cefr: 'A2', label: 'Everyday' },
  { id: 'Moderate', cefr: 'B1', label: 'Common' },
  { id: 'Advanced', cefr: 'B2', label: 'Academic' },
  { id: 'God Level', cefr: 'C2', label: 'Rare' },
];

export const PLACEMENT = {
  /** Questions in a full sitting. Long enough to place, short enough to finish. */
  length: 16,
  /**
   * The sitting opens with a calibration sweep: this many items at every band,
   * in order, before the ladder takes over.
   *
   * Without it the ladder pins. A learner who answers everything right reaches
   * the top band by question three and spends the remaining thirteen there —
   * every other band ends on one item, below `minItems`, so nothing else can be
   * judged and a flawless score reports itself as "provisional". Two items per
   * band costs eight questions and makes every band judgeable; the ladder then
   * spends the other eight refining the boundary, which is the only place the
   * extra precision is worth anything.
   */
  sweep: 2,
  /** Where the ladder starts once the sweep is done. */
  startBand: 1,
  /** Accuracy a band must reach to count as held. */
  passRate: 0.7,
  /** A band needs this many items before its accuracy means anything. */
  minItems: 2,
  options: 4,
};

const KINDS = ['meaning', 'recall', 'synonym'];

/**
 * Group a flat list of module words by band.
 * Words without a definition can't be asked about, so they never enter the pool.
 */
export function poolByBand(words) {
  const pool = new Map(BANDS.map((b) => [b.id, []]));
  for (const w of words) {
    const bucket = pool.get(w.x);
    if (bucket && w.d && w.w) bucket.push(w);
  }
  return pool;
}

/** Open a sitting. `pool` is the Map from poolByBand. */
export function startPlacement(pool, { length = PLACEMENT.length, sweep = PLACEMENT.sweep } = {}) {
  return {
    pool,
    length,
    // The calibration sweep, as a queue of band indexes: every band once, then
    // every band again, so an early quit still leaves a spread rather than two
    // items at the easiest band.
    sweep: Array.from({ length: sweep }, () => BANDS.map((_, i) => i)).flat(),
    band: PLACEMENT.startBand,
    asked: [],          // { band, kind, term, correct }
    used: new Set(),    // terms already asked, so nothing repeats
    question: null,
  };
}

/** Over when the planned length is reached, or when no band can supply an item. */
export const placementDone = (run) => run.asked.length >= run.length || run.exhausted === true;

/**
 * Build the next question at the ladder's current band.
 *
 * Falls back to a neighbouring band when the current one is exhausted — with
 * 272 "God Level" words and a 16-question exam that is unlikely, but a pool
 * that runs dry must not end the exam early or throw.
 */
export function nextQuestion(run, rng = Math.random) {
  // The sweep runs first and ignores the ladder entirely.
  const target = run.sweep?.length ? run.sweep[0] : run.band;
  for (const index of nearestBands(target)) {
    const band = BANDS[index];
    const all = run.pool.get(band.id) || [];
    // Only the word being *asked about* has to be new. Distractors may repeat
    // across questions — a wrong option gives nothing away — and requiring four
    // unused words per item used to strand the exam on a thin band.
    const fresh = all.filter((w) => !run.used.has(w.w));
    if (!fresh.length || all.length < PLACEMENT.options) continue;

    const kind = pickKind(run.asked.length, fresh, rng);
    const question = buildItem(kind, band, fresh, all, rng);
    if (!question) continue;

    run.used.add(question.term);
    run.question = question;
    if (run.sweep?.length) run.sweep.shift();
    return question;
  }
  // Nothing left anywhere: end the sitting rather than stranding the learner on
  // a screen with no question. Real pools hold hundreds per band and never
  // reach this; a trimmed fork might.
  run.question = null;
  run.exhausted = true;
  return null;
}

/** Bands to try, current first, then outward — never off the ends. */
function nearestBands(from) {
  const order = [from];
  for (let step = 1; step < BANDS.length; step += 1) {
    if (from - step >= 0) order.push(from - step);
    if (from + step < BANDS.length) order.push(from + step);
  }
  return order;
}

/** Rotate the three kinds, but only ask for a synonym when one exists. */
function pickKind(cursor, fresh, rng) {
  for (let step = 0; step < KINDS.length; step += 1) {
    const kind = KINDS[(cursor + step) % KINDS.length];
    if (kind !== 'synonym') return kind;
    if (fresh.some((w) => (w.s || []).length)) return kind;
  }
  return 'meaning';
}

/**
 * One item. Every distractor is drawn from `fresh`, which is a single band —
 * this is the property the exam's validity rests on.
 */
function buildItem(kind, band, fresh, all, rng) {
  const candidates = kind === 'synonym' ? fresh.filter((w) => (w.s || []).length) : fresh;
  if (!candidates.length) return null;
  const answer = candidates[Math.floor(rng() * candidates.length)];
  const others = all.filter((w) => w.w !== answer.w);
  if (others.length < PLACEMENT.options - 1) return null;

  const base = { band: band.id, cefr: band.cefr, kind, term: answer.w };

  if (kind === 'meaning') {
    const wrong = sample(others, PLACEMENT.options - 1, rng).map((w) => w.d);
    return withOptions(base, `What does “${answer.w}” mean?`, answer.d, wrong, rng);
  }
  if (kind === 'recall') {
    const wrong = sample(others, PLACEMENT.options - 1, rng).map((w) => w.w);
    return withOptions(base, `Which word means “${answer.d}”?`, answer.w, wrong, rng);
  }
  // synonym: the right answer is a real synonym; the wrong ones are same-band
  // words that are not synonyms of it.
  const synonyms = new Set((answer.s || []).map((s) => s.toLowerCase()));
  const right = answer.s[Math.floor(rng() * answer.s.length)];
  const usable = others.filter((w) => !synonyms.has(w.w.toLowerCase()));
  if (usable.length < PLACEMENT.options - 1) return null;
  const wrong = sample(usable, PLACEMENT.options - 1, rng).map((w) => w.w);
  return withOptions(base, `Which word is closest in meaning to “${answer.w}”?`, right, wrong, rng);
}

function withOptions(base, prompt, right, wrong, rng) {
  const options = shuffle([right, ...wrong], rng);
  const answerIndex = options.indexOf(right);
  if (answerIndex === -1 || new Set(options).size !== options.length) return null;
  return { ...base, prompt, options, answerIndex };
}

/**
 * Record an answer and move the ladder: up on a right answer, down on a wrong
 * one, never past either end.
 */
export function answerPlacement(run, choice) {
  const q = run.question;
  if (!q) return null;
  const correct = choice === q.answerIndex;
  run.asked.push({ band: q.band, kind: q.kind, term: q.term, correct });
  run.question = null;

  if (run.sweep?.length) {
    // Mid-sweep: the band is dictated by the sweep, so stepping the ladder here
    // would just leave it wherever the sweep's last item happened to sit.
    return { correct, answerIndex: q.answerIndex };
  }
  if (!run.laddered) {
    // Sweep just ended. Hand over at the boundary the sweep found — one above
    // the hardest band they passed — so the adaptive half starts by testing the
    // thing still in doubt rather than re-testing settled ground.
    run.laddered = true;
    run.band = handover(run);
    return { correct, answerIndex: q.answerIndex };
  }
  run.band = clampBand(run.band + (correct ? 1 : -1));
  return { correct, answerIndex: q.answerIndex };
}

const clampBand = (i) => Math.max(0, Math.min(BANDS.length - 1, i));

/** One rung above the hardest band the sweep saw answered without error. */
function handover(run) {
  let highest = -1;
  BANDS.forEach((band, i) => {
    const items = run.asked.filter((a) => a.band === band.id);
    if (items.length && items.every((a) => a.correct)) highest = i;
  });
  return clampBand(highest + 1);
}

/**
 * What the answers say about the learner.
 *
 * `level` is the CEFR of the highest band answered at the pass rate over enough
 * items. `confidence` is low when few bands got enough items to judge — a
 * 16-question exam that ping-ponged can leave a band with one item, and saying
 * so is better than pretending to a precision the data has not got.
 */
export function estimate(run, poolSizes = null) {
  const perBand = BANDS.map((band) => {
    const items = run.asked.filter((a) => a.band === band.id);
    const right = items.filter((a) => a.correct).length;
    return {
      band: band.id,
      cefr: band.cefr,
      label: band.label,
      seen: items.length,
      right,
      accuracy: items.length ? right / items.length : null,
      judged: items.length >= PLACEMENT.minItems,
    };
  });

  let held = -1;
  for (let i = 0; i < perBand.length; i += 1) {
    const b = perBand[i];
    if (b.judged && b.accuracy >= PLACEMENT.passRate) held = i;
  }

  // Nothing cleared the bar: place at the easiest band rather than claiming a
  // level from a single lucky answer.
  const index = held === -1 ? 0 : held;
  const judged = perBand.filter((b) => b.judged).length;
  const total = run.asked.length;
  const right = run.asked.filter((a) => a.correct).length;

  return {
    level: BANDS[index].cefr,
    band: BANDS[index].id,
    bandIndex: index,
    reached: held !== -1,
    perBand,
    answered: total,
    correct: right,
    accuracy: total ? right / total : 0,
    confidence: judged >= 3 ? 'good' : judged === 2 ? 'fair' : 'rough',
    knownWords: poolSizes ? knownWords(perBand, poolSizes) : null,
    at: Date.now(),
  };
}

/**
 * How many of the app's own banded words the learner would likely know.
 *
 * Deliberately not "your English vocabulary is N words" — that would be a
 * fabrication from 16 questions. This is measured accuracy per band applied to
 * the words this app actually holds in that band, and the UI says so.
 */
export function knownWords(perBand, poolSizes) {
  let known = 0;
  let total = 0;
  for (const b of perBand) {
    const size = poolSizes[b.band] || 0;
    total += size;
    if (b.accuracy != null) known += size * b.accuracy;
  }
  return { known: Math.round(known), total };
}

// ── helpers ────────────────────────────────────────────────────────────────

function sample(list, n, rng) {
  return shuffle(list, rng).slice(0, n);
}

function shuffle(list, rng = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
