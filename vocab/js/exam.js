/**
 * Exams.
 *
 * A set of ten words ends in a short test of three kinds, because knowing a
 * word means three different things:
 *
 *   meaning  the word is shown, pick what it means
 *   usage    a real sentence with the word blanked out, pick the word
 *   recall   the meaning is shown, pick the word
 *
 * Everything is generated from the words themselves — no network, no AI — so
 * an exam works offline and is always about the set just studied. Distractors
 * come from the same set first, which makes the test harder and fairer than
 * pulling random unrelated words.
 */

export const QUESTION_KINDS = ['meaning', 'usage', 'recall'];

/** How the mark turns into points. Also see AWARDS in xp.js. */
export const EXAM_XP = {
  perCorrect: 10,
  passMark: 70,        // percent
  passBonus: 25,
  perfectBonus: 50,
};

/**
 * Build an exam for a set of words.
 * @param {Array} words   the set being tested, each {term, definition, examples[]}
 * @param {Array} pool    more words to draw wrong answers from (optional)
 * @param {Function} rng  injectable for tests
 */
export function buildExam(words, pool = [], rng = Math.random) {
  const usable = words.filter((w) => w.term && w.definition);
  const distractorPool = dedupe([...usable, ...pool]);

  const questions = [];
  for (const [i, word] of usable.entries()) {
    const question = make(pickKind(word, i), word, distractorPool, rng);
    if (question) questions.push(question);
  }
  return shuffle(questions, rng);
}

/**
 * Rotate the three kinds across the set.
 *
 * The cursor has to advance globally, not per word: rotating each word within
 * only the kinds it supports meant a set of mixed words could go through
 * without ever asking a `recall` question.
 */
function pickKind(word, cursor) {
  const hasExample = (word.examples || []).some((e) => usableExample(e, word.term));
  for (let step = 0; step < QUESTION_KINDS.length; step += 1) {
    const kind = QUESTION_KINDS[(cursor + step) % QUESTION_KINDS.length];
    if (kind === 'usage' && !hasExample) continue;
    return kind;
  }
  return 'meaning';
}

function make(kind, word, pool, rng) {
  if (kind === 'usage') return usageQuestion(word, pool, rng) || meaningQuestion(word, pool, rng);
  if (kind === 'recall') return recallQuestion(word, pool, rng);
  return meaningQuestion(word, pool, rng);
}

function meaningQuestion(word, pool, rng) {
  const wrong = otherWords(pool, word, rng, 3).map((w) => w.definition);
  if (wrong.length < 2) return null;
  return finish({
    kind: 'meaning',
    term: word.term,
    prompt: `What does “${word.term}” mean?`,
    correct: word.definition,
    options: [word.definition, ...wrong],
  }, rng);
}

function recallQuestion(word, pool, rng) {
  const wrong = otherWords(pool, word, rng, 3).map((w) => w.term);
  if (wrong.length < 2) return null;
  return finish({
    kind: 'recall',
    term: word.term,
    prompt: `Which word means “${word.definition}”?`,
    correct: word.term,
    options: [word.term, ...wrong],
  }, rng);
}

function usageQuestion(word, pool, rng) {
  const example = (word.examples || []).find((e) => usableExample(e, word.term));
  if (!example) return null;
  const wrong = otherWords(pool, word, rng, 3).map((w) => w.term);
  if (wrong.length < 2) return null;
  return finish({
    kind: 'usage',
    term: word.term,
    prompt: blank(example, word.term),
    correct: word.term,
    options: [word.term, ...wrong],
  }, rng);
}

/** An example is only usable if the word is actually in it to blank out. */
function usableExample(sentence, term) {
  return typeof sentence === 'string'
    && sentence.split(' ').length >= 4
    && wordPattern(term).test(sentence);
}

function wordPattern(term) {
  const stem = term.replace(/(?:e?s|ed|ing|ly)$/i, '');
  return new RegExp(`\\b${escapeRe(stem.length >= 3 ? stem : term)}\\w*`, 'i');
}

function blank(sentence, term) {
  return sentence.replace(wordPattern(term), '_____');
}

function finish(question, rng) {
  const options = shuffle(dedupeStrings(question.options), rng);
  return { ...question, options, answerIndex: options.indexOf(question.correct) };
}

function otherWords(pool, word, rng, count) {
  const others = pool.filter((w) => w.term !== word.term && w.definition);
  return shuffle(others, rng).slice(0, count);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dedupe = (words) => [...new Map(words.map((w) => [w.term, w])).values()];
const dedupeStrings = (list) => [...new Set(list.filter(Boolean))];

function shuffle(list, rng = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Mark an exam.
 * @param {Array} questions
 * @param {Array<number>} answers  index chosen per question, -1 for skipped
 */
export function markExam(questions, answers) {
  const correct = questions.reduce(
    (n, q, i) => n + (answers[i] === q.answerIndex ? 1 : 0), 0);
  const total = questions.length;
  const percent = total ? Math.round((correct / total) * 100) : 0;

  let xp = correct * EXAM_XP.perCorrect;
  if (percent >= EXAM_XP.passMark) xp += EXAM_XP.passBonus;
  if (percent === 100) xp += EXAM_XP.perfectBonus;

  return {
    correct,
    total,
    percent,
    passed: percent >= EXAM_XP.passMark,
    xp,
    wrong: questions.filter((q, i) => answers[i] !== q.answerIndex).map((q) => q.term),
  };
}

/** Split a module's words into the sets a learner works through. */
export function chunk(words, size = 10) {
  const sets = [];
  for (let i = 0; i < words.length; i += size) sets.push(words.slice(i, i + size));
  return sets;
}
