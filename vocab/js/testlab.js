/**
 * The Test section — five ways to be examined, on two subjects.
 *
 * Everything that decides *what* a question is lives here, pure and testable.
 * The view only draws what this returns and reports back what was answered.
 *
 * The five modes are genuinely different demands, not one question dressed five
 * ways: recognition (flashcard), discrimination (quiz), production in context
 * (in sentence), sustained recall under a mark (written exam) and orthography
 * (spelling). A learner can pass a quiz on a word they cannot spell or use.
 */

export const SUBJECTS = {
  vocabulary: { label: 'Vocabulary', hint: 'Words: what they mean, and how to use them.' },
  grammar: { label: 'Grammar', hint: 'Tenses, articles, prepositions, conditionals and the rest.' },
};

export const MODES = {
  flashcard: {
    label: 'Flashcards', hint: 'See it, recall it, turn it over. No marks.',
    icon: 'i-book', graded: false, subjects: ['vocabulary', 'grammar'],
  },
  quiz: {
    label: 'Quiz', hint: 'Four options, one right. Quick and marked.',
    icon: 'i-check', graded: true, subjects: ['vocabulary', 'grammar'],
  },
  sentence: {
    label: 'In a sentence', hint: 'Fill the gap, or write the word into one of your own.',
    icon: 'i-pen', graded: true, subjects: ['vocabulary', 'grammar'],
  },
  written: {
    label: 'Written exam', hint: 'Fifteen mixed questions, one mark at the end.',
    icon: 'i-ledger', graded: true, subjects: ['vocabulary', 'grammar'], length: 15,
  },
  spelling: {
    label: 'Spelling', hint: 'Read the meaning, type the word.',
    icon: 'i-index', graded: true, subjects: ['vocabulary'],
  },
};

/** Modes offered for a subject. Spelling has no meaning for grammar. */
export const modesFor = (subject) =>
  Object.entries(MODES).filter(([, m]) => m.subjects.includes(subject));

export const DEFAULT_LENGTH = 10;

// ── building a round ───────────────────────────────────────────────────────

/**
 * One round of questions.
 *
 * `words` are pack entries ({ w, d, s, p, x }); `grammar` are bank items.
 * Returns questions in a single shape whatever the mode, so the view stays
 * simple and marking stays in one place.
 */
export function buildRound({ subject, mode, words = [], grammar = [], length, rng = Math.random }) {
  const size = length || MODES[mode]?.length || DEFAULT_LENGTH;
  if (subject === 'grammar') return grammarRound(mode, grammar, size, rng);
  return vocabRound(mode, words, size, rng);
}

function grammarRound(mode, bank, size, rng) {
  const items = shuffle(bank, rng).slice(0, size);
  return items.map((item) => {
    const base = { subject: 'grammar', topic: item.t, level: item.lv, why: item.w };
    if (mode === 'flashcard') {
      return { ...base, kind: 'flashcard', prompt: item.q.replace('____', '…'),
               answer: item.o[item.a], detail: item.w };
    }
    if (mode === 'sentence') {
      // Same item, but typed rather than chosen — production, not recognition.
      return { ...base, kind: 'type', prompt: item.q, accept: [item.o[item.a]] };
    }
    return { ...base, kind: 'choice', prompt: item.q, options: item.o, answerIndex: item.a };
  });
}

function vocabRound(mode, words, size, rng) {
  const usable = words.filter((w) => w.w && w.d);
  const picked = shuffle(usable, rng).slice(0, size);

  return picked.map((word, i) => {
    const base = { subject: 'vocabulary', term: word.w, level: word.x || '' };
    const others = usable.filter((w) => w.w !== word.w);

    if (mode === 'flashcard') {
      return { ...base, kind: 'flashcard', prompt: word.w,
               answer: word.d, detail: (word.s || []).slice(0, 4).join(', ') };
    }
    if (mode === 'spelling') {
      return { ...base, kind: 'type', prompt: word.d,
               hint: `${word.w.length} letters, starts with “${word.w[0]}”`, accept: [word.w] };
    }
    if (mode === 'sentence') {
      return { ...base, kind: 'write', prompt: word.w, definition: word.d,
               accept: [word.w] };
    }
    // quiz and written: rotate the three question kinds so a round tests
    // recognition in both directions rather than the same one ten times.
    const kinds = ['meaning', 'recall', 'synonym'];
    for (let step = 0; step < kinds.length; step += 1) {
      const kind = kinds[(i + step) % kinds.length];
      const built = choiceItem(kind, word, others, rng);
      if (built) return { ...base, ...built };
    }
    return { ...base, ...choiceItem('meaning', word, others, rng) };
  }).filter(Boolean);
}

/** One four-option item. Distractors come from the same pack, never at random. */
function choiceItem(kind, word, others, rng) {
  if (others.length < 3) return null;

  if (kind === 'meaning') {
    const wrong = sample(others, 3, rng).map((w) => w.d);
    return withOptions('choice', `What does “${word.w}” mean?`, word.d, wrong, rng, kind);
  }
  if (kind === 'recall') {
    const wrong = sample(others, 3, rng).map((w) => w.w);
    return withOptions('choice', `Which word means “${word.d}”?`, word.w, wrong, rng, kind);
  }
  const synonyms = (word.s || []).filter(Boolean);
  if (!synonyms.length) return null;
  const right = synonyms[Math.floor(rng() * synonyms.length)];
  const taken = new Set(synonyms.map((s) => s.toLowerCase()).concat(word.w.toLowerCase()));
  const pool = others.filter((w) => !taken.has(w.w.toLowerCase()));
  if (pool.length < 3) return null;
  const wrong = sample(pool, 3, rng).map((w) => w.w);
  return withOptions('choice', `Which is closest in meaning to “${word.w}”?`, right, wrong, rng, kind);
}

function withOptions(kind, prompt, right, wrong, rng, tag) {
  const options = shuffle([right, ...wrong], rng);
  const answerIndex = options.indexOf(right);
  if (answerIndex === -1 || new Set(options).size !== options.length) return null;
  return { kind, prompt, options, answerIndex, tag };
}

// ── marking ────────────────────────────────────────────────────────────────

/** Spelling and typed answers forgive case, spacing and surrounding quotes. */
export const normalise = (s) =>
  String(s ?? '').toLowerCase().trim().replace(/[“”"'’.,!?;:]/g, '').replace(/\s+/g, ' ');

/**
 * Is one answer right?
 *
 * `write` mode is the odd one: the learner produces a whole sentence, and the
 * only thing that can be checked without a model is that the word is genuinely
 * in it and the sentence is a sentence. That is stated in the UI rather than
 * dressed up as full marking.
 */
export function markOne(question, given) {
  if (question.kind === 'choice') {
    return { correct: given === question.answerIndex, expected: question.options?.[question.answerIndex] };
  }
  if (question.kind === 'type') {
    const want = (question.accept || []).map(normalise);
    return { correct: want.includes(normalise(given)), expected: question.accept?.[0] };
  }
  if (question.kind === 'write') {
    const text = String(given || '').trim();
    const used = usesTerm(text, question.term);
    const long = text.split(/\s+/).filter(Boolean).length >= 5;
    return {
      correct: used && long,
      expected: question.term,
      notes: [
        used ? `✓ You used “${question.term}”.` : `✗ “${question.term}” is not in that sentence.`,
        long ? '✓ Long enough to show the word working.' : '✗ Too short — aim for eight words or more.',
      ],
    };
  }
  return { correct: null, expected: question.answer };   // flashcards are not marked
}

/** Does the sentence contain the word, allowing ordinary inflections? */
export function usesTerm(sentence, term) {
  const lower = String(term || '').toLowerCase();
  if (!lower) return false;
  let root = lower.replace(/(ing|ed|es|s)$/, '');
  if (root.length < 4) root = lower;
  if (root.length > 4 && root.endsWith('e')) root = root.slice(0, -1);
  return new RegExp(`\\b${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(sentence);
}

export const PASS_MARK = 0.7;

/** The whole round. XP mirrors the module exams so one currency runs the app. */
export function markRound(questions, answers) {
  const graded = questions.filter((q) => q.kind !== 'flashcard');
  let correct = 0;
  const wrong = [];

  graded.forEach((q, i) => {
    const index = questions.indexOf(q);
    const result = markOne(q, answers[index]);
    if (result.correct) correct += 1;
    else wrong.push(q.term || q.topic || q.prompt);
  });

  const total = graded.length;
  const percent = total ? Math.round((correct / total) * 100) : 0;
  const passed = total > 0 && percent >= PASS_MARK * 100;
  return {
    correct, total, percent, passed, wrong,
    xp: total ? correct * 10 + (passed ? 25 : 0) + (percent === 100 ? 50 : 0) : 0,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function sample(list, n, rng) { return shuffle(list, rng).slice(0, n); }

function shuffle(list, rng = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
