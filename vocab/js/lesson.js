/**
 * Studying one set of ten words.
 *
 * A set runs in two halves. First the words themselves, one card at a time —
 * meaning, translation, an example if the data had one. Then a short exam over
 * the same ten, marked out of 100, which is what pays the XP. The mark is kept
 * so the module screen can show which sets are done and how well.
 */
import { Store, makeSrs } from './store.js';
import { buildExam, markExam, EXAM_XP } from './exam.js';
import { award, claimDailyBonuses } from './xp.js';
import { Translate } from './translate.js';
import { $, $$, el, icon, toast, switchView } from './ui.js';

const SET_SIZE = 10;

/** Live state of the set on screen. Nothing here outlives the lesson. */
let run = null;
let hooks = {};

export function configureLesson(options) { hooks = options; }

/** The live set, for the console and the browser tests. */
export function currentLesson() { return run; }

/** Progress a learner has made through a module's sets. */
export function setResults(moduleId) {
  return Store.state.lessons?.[moduleId] || {};
}

export function recordSet(moduleId, index, result) {
  Store.commit((state) => {
    const lessons = (state.lessons ||= {});
    const module = (lessons[moduleId] ||= {});
    const before = module[index] || { best: 0, attempts: 0 };
    module[index] = {
      best: Math.max(before.best, result.percent),
      passed: before.passed || result.passed,
      attempts: before.attempts + 1,
      at: Date.now(),
    };
  });
}

/** Open set `index` of `module` (a manifest entry) with its words. */
export function startLesson(module, index, words, pool = []) {
  run = {
    module,
    index,
    words,
    pool,
    phase: 'cards',
    cardIndex: 0,
    revealed: false,
    questions: [],
    qIndex: 0,
    answers: [],
  };
  switchView('lesson');
  drawCards();
}

export function wireLesson() {
  $('#lessonQuit').addEventListener('click', quit);
  $('#lessonShow').addEventListener('click', () => { run.revealed = true; drawCards(); });
  $('#lessonNext').addEventListener('click', nextCard);
  $('#examNext').addEventListener('click', nextQuestion);
  $('#resultRetry').addEventListener('click', () => startLesson(run.module, run.index, run.words, run.pool));
  $('#resultNextSet').addEventListener('click', () => hooks.onNextSet?.(run.module, run.index + 1));
  $('#resultDone').addEventListener('click', () => hooks.onDone?.(run.module));
}

function quit() {
  const done = run?.phase === 'result';
  run = null;
  hooks.onDone?.(done ? null : undefined);
}

// ── half one: the words ────────────────────────────────────────────────────
function drawCards() {
  const word = run.words[run.cardIndex];
  show('cards');
  meter(run.cardIndex, run.words.length * 2);
  $('#lessonCount').textContent = `Word ${run.cardIndex + 1} of ${run.words.length}`;
  $('#lessonStage').textContent = 'Learn the word';
  $('#lessonTerm').textContent = word.term;
  $('#lessonPos').textContent = word.pos || '';
  $('#lessonDef').textContent = word.definition || '';

  const examples = $('#lessonExamples');
  examples.replaceChildren(...(word.examples || []).slice(0, 2).map((e) => el('li', { text: e })));

  $('#lessonBack').hidden = !run.revealed;
  $('#lessonShow').hidden = run.revealed;
  $('#lessonNext').hidden = !run.revealed;
  $('#lessonNext').textContent =
    run.cardIndex === run.words.length - 1 ? 'Start the exam' : 'Next word';

  const tr = $('#lessonTr');
  tr.hidden = true;
  if (run.revealed && Translate.active) {
    Translate.word(word).then((result) => {
      if (!run || run.words[run.cardIndex]?.term !== word.term) return;
      if (!result) return;
      tr.hidden = false;
      tr.dir = Translate.info()?.rtl ? 'rtl' : 'ltr';
      tr.textContent = result.text;
    });
  }
}

function nextCard() {
  if (run.cardIndex < run.words.length - 1) {
    run.cardIndex += 1;
    run.revealed = false;
    drawCards();
    return;
  }
  beginExam();
}

// ── half two: the exam ─────────────────────────────────────────────────────
function beginExam() {
  run.questions = buildExam(run.words, run.pool);
  if (!run.questions.length) {          // a set too small to examine
    finish({ correct: 0, total: 0, percent: 100, passed: true, xp: 0, wrong: [] });
    return;
  }
  run.phase = 'exam';
  run.qIndex = 0;
  run.answers = [];
  drawQuestion();
}

function drawQuestion() {
  const q = run.questions[run.qIndex];
  show('exam');
  meter(run.words.length + run.qIndex, run.words.length + run.questions.length);
  $('#lessonCount').textContent = `Question ${run.qIndex + 1} of ${run.questions.length}`;
  $('#examKind').textContent =
    { meaning: 'What it means', usage: 'Fill the gap', recall: 'Which word' }[q.kind];
  $('#examPrompt').textContent = q.prompt;
  $('#examFeedback').hidden = true;
  $('#examNext').hidden = true;
  $('#examOptions').replaceChildren(...q.options.map((option, i) =>
    el('button', { class: 'option', onclick: () => answer(i) }, option)));
}

function answer(index) {
  const q = run.questions[run.qIndex];
  run.answers[run.qIndex] = index;
  const right = index === q.answerIndex;

  for (const [i, button] of $$('#examOptions .option').entries()) {
    button.disabled = true;
    if (i === q.answerIndex) { button.classList.add('is-correct'); button.append(icon('check')); }
    else if (i === index) { button.classList.add('is-wrong'); button.append(icon('close')); }
  }

  // An exam answer is a review like any other, so the daily goal, the activity
  // chart and the streak all move while studying a module.
  Store.bumpDay({ reviews: 1, correct: right ? 1 : 0 });
  Store.logReview({ wordId: q.term, correct: right, grade: right ? 2 : 0, mode: `exam:${q.kind}` });

  const feedback = $('#examFeedback');
  feedback.hidden = false;
  feedback.className = `feedback ${right ? 'is-ok' : 'is-bad'}`;
  feedback.textContent = right
    ? 'Correct.'
    : `The answer is “${q.correct}”.`;

  $('#examNext').hidden = false;
  $('#examNext').textContent =
    run.qIndex === run.questions.length - 1 ? 'See your score' : 'Next question';
}

function nextQuestion() {
  if (run.qIndex < run.questions.length - 1) {
    run.qIndex += 1;
    drawQuestion();
    return;
  }
  finish(markExam(run.questions, run.answers));
}

// ── the mark ───────────────────────────────────────────────────────────────
function finish(result) {
  run.phase = 'result';
  show('result');
  meter(1, 1);
  $('#lessonCount').textContent = 'Finished';

  // The words of a passed set join the deck, so spaced repetition takes over.
  const added = adoptWords(run.words, run.module.id, result.passed);
  recordSet(run.module.id, run.index, result);
  if (result.xp) award(result.xp, { module: run.module.id });
  if (added) Store.bumpDay({ learned: added });
  claimDailyBonuses();

  $('#resultScore').textContent = `${result.percent}%`;
  $('#resultLine').textContent = result.total
    ? `${result.correct} of ${result.total} right${result.passed ? ' — set passed.' : ` — ${EXAM_XP.passMark}% needed to pass.`}`
    : 'Set finished.';
  $('#resultXp').textContent = result.xp ? `+${result.xp} XP` : 'No XP this time — try again.';

  const wrongBox = $('#resultWrongBox');
  wrongBox.hidden = !result.wrong.length;
  $('#resultWrong').replaceChildren(...result.wrong.map((term) => el('span', { class: 'chip', text: term })));

  if (added) toast(`${added} word${added === 1 ? '' : 's'} added to your reviews.`);
  hooks.onFinished?.(run.module, run.index, result);
}

/** Put the set's words in the deck so they come back for review. */
function adoptWords(words, moduleId, passed) {
  let added = 0;
  Store.commit((state) => {
    for (const word of words) {
      if (state.words[word.id]) continue;
      state.words[word.id] = { ...word, module: moduleId, addedAt: Date.now() };
      state.srs[word.id] = makeSrs();
      added += 1;
    }
  });
  return added;   // the XP for a set comes from the exam mark, not from adding
}

// ── plumbing ───────────────────────────────────────────────────────────────
function show(phase) {
  $('#lessonCard').hidden = phase !== 'cards';
  $('#lessonExam').hidden = phase !== 'exam';
  $('#lessonResult').hidden = phase !== 'result';
}

function meter(done, total) {
  $('#lessonFill').style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
}

export const SET_WORDS = SET_SIZE;
