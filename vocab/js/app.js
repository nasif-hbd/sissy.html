/**
 * VocabX — controller.
 *
 * Owns session state (which card is on screen, which quiz question is live)
 * and wires every control to the modules that do the actual work:
 *   store.js  persistence      srs.js    scheduling
 *   stats.js  tracking         notify.js reminders
 *   ai.js     Claude calls     ui.js     rendering
 */
import { APP, AI as AICFG, THEMES, PROVIDERS } from './config.js';
import { Store, refreshStreak, makeSrs, dayKey, snapshot, restore } from './store.js';
import { schedule, buildQueue, bucket, plannedSession, queueCounts, spokenDelta } from './srs.js';
import { makeSessionTimer, reportPayload, weakest, summary, window as windowStats, recentDays,
         dashboard, recentlyLearned, activeDays } from './stats.js';
import { Notifier, Push } from './notify.js';
import { AIClient } from './ai.js';
import {
  $, $$, el, icon, toast, announce, applyTheme, switchView, renderHeader, renderQueueSummary,
  renderCard, renderEmptyQueue, renderWordList, renderProgress, renderSuggestions,
  renderModules, renderModuleDetail, renderHome, renderXp, practicePool, actionSheet,
  renderPlacementQuestion, renderPlacementResult, renderLevelSummary, renderChat, sizeChat,
  renderTestSubjects, renderTestPacks, renderTestModes, renderTestQuestion,
  showTestFeedback, renderTestResult, renderInstall,
} from './ui.js';
import { Catalog } from './catalog.js';
import { AWARDS, award, claimDailyBonuses, standing, moduleStandings, bestDays } from './xp.js';
import { chunk } from './exam.js';
import { configureLesson, wireLesson, startLesson, setResults, currentLesson, SET_WORDS } from './lesson.js';
import { Translate, LANGUAGES } from './translate.js';
import {
  poolByBand, startPlacement, nextQuestion, answerPlacement, placementDone, estimate, BANDS,
} from './placement.js';
import { buildPlan } from './advice.js';
import { ACTIONS, makeStep, sortRoutine, validTime, cardFor, quoteFor } from './routine.js';
import { STARTERS, contextFor } from './chat.js';
import { feedbackAsText, feedbackSubject, feedbackMailto } from './feedback.js';
import { SUBJECTS, modesFor, buildRound, markOne, markRound } from './testlab.js';
import { createInstaller } from './install.js';

// ── session state ──────────────────────────────────────────────────────────
const session = {
  queue: [],
  currentId: null,
  revealed: false,
  ahead: false,
  shownAt: 0,
  practiceMode: 'quiz',
  quiz: null,     // { wordId, options, answerIndex, explanation }
  spell: null,    // { wordId }
  coachWordId: null,
  wordQuery: '',
  wordFilter: 'all',
  module: null,      // the module currently open
  sets: [],
  continueSet: null,
};

const timer = makeSessionTimer((seconds) => Store.bumpDay({ seconds }));

// ── boot ───────────────────────────────────────────────────────────────────
// (boot() is called at the very bottom of this file, once every helper below
//  has been initialised — `render()` runs synchronously inside it.)

async function boot() {
  await Store.init();
  refreshStreak(Store.state);
  applyTheme(Store.state.settings.theme);

  wireTabs();
  wireTopSearch();
  wireLearn();
  wirePractice();
  wireHome();
  wireModules();
  wireLesson();
  configureLesson({
    onDone: () => { openModule(session.module) || switchView('modules'); render(); },
    onNextSet: (module, index) => startSet(module, index),
    onFinished: () => { render(); loadModules(); },
  });
  wireWords();
  wireInstall();
  wireFeedback();
  wireTest();
  wireAsk();
  wireAssess();
  wireProgress();
  wireSettings();
  wireKeyboard();

  Store.on(() => renderHeader(Store.state));
  render();

  $('#app').hidden = false;

  const startView = location.hash.replace('#', '');
  if ($$('.tab').some((t) => t.dataset.tab === startView)) switchView(startView);
  else switchView('home');

  await Notifier.registerServiceWorker();
  if (Store.state.settings.reminders.enabled) Notifier.start();
  refreshNotifyState();

  /* The leaderboard names modules and Home lists the ones with work in them,
     so fetch the manifest quietly at boot — and redraw both once it lands, or
     Home shows "nothing started yet" to someone who has started three. */
  Catalog.modules().then((m) => {
    moduleManifest = m;
    drawXp(Store.state);
    drawHome(Store.state);
  }).catch(() => {});

  timer.resume();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { timer.resume(); Notifier.tick(); render(); }
    else timer.flush();
  });
  addEventListener('pagehide', () => timer.flush());
  setInterval(() => { timer.flush(); timer.resume(); }, 60_000);

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (Store.state.settings.theme === 'auto') applyTheme('auto');
  });

  // Exposed deliberately: handy in the console, and the hook the browser tests
  // use to reach internals. Drop this line if you'd rather keep it sealed.
  window.VocabX = { Store, Notifier, Push, AIClient, session, render, lesson: currentLesson, placement: () => placementRun, lab: () => lab };

  console.info(`${APP.name} ready — ${Object.keys(Store.state.words).length} words in deck.`);
}

/** Full redraw. Cheap enough to call on any change. */
/** The stock the page is printed on. */
function labelTheme(theme) {
  $('#themeLabel').textContent = THEMES.find((t) => t.id === theme)?.label ?? 'Auto';
}

function setTheme(id) {
  Store.set('settings.theme', id);
  applyTheme(id);
  labelTheme(id);
  markTheme(id);
}

/**
 * Swatches in Settings: a strip of the theme's paper against its accent.
 * Built once — re-rendering the buttons from inside their own click handler
 * tears down the element mid-dispatch, and the event lands somewhere else.
 */
function renderThemes() {
  $('#themePicker').replaceChildren(...THEMES.map((t) =>
    el('button', {
      class: 'swatch',
      type: 'button',
      title: t.note,
      'data-theme-id': t.id,
      style: `--sw-paper:${t.paper};--sw-accent:${t.accent}`,
      onclick: () => setTheme(t.id),
    }, el('span', { class: 'swatch__chip' }), t.label)));
  markTheme(Store.state.settings.theme);
}

/** Selection is a class flip, never a rebuild. */
function markTheme(id) {
  for (const swatch of $$('#themePicker .swatch')) {
    const active = swatch.dataset.themeId === id;
    swatch.classList.toggle('is-active', active);
    swatch.setAttribute('aria-pressed', String(active));
  }
}

function render() {
  const state = Store.state;
  renderHeader(state);
  renderQueueSummary(state);
  drawCurrentCard();
  refreshWordList();
  renderProgress(state);
  drawXp(state);
  drawHome(state);
  renderLevelSummary(state.placement || null);
}

/** The level card and the leaderboard live in the Ledger view. */
function drawXp(state) {
  const total = state.xp?.total || 0;
  const manifest = moduleManifest;
  renderXp(
    standing(total),
    moduleStandings(state, manifest).filter((m) => m.xp || m.words).slice(0, 6)
      .map((m) => ({ name: m.title, sub: `${m.words} word${m.words === 1 ? '' : 's'} in your deck`, xp: m.xp })),
    bestDays(state, 5).map((d) => ({
      name: new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }),
      sub: `${state.days[d.day]?.reviews || 0} reviews`,
      xp: d.xp,
    })),
    total,
  );
}

// ── tabs ───────────────────────────────────────────────────────────────────
/**
 * The rail opens and closes, and stays how it was left.
 *
 * It is closed to begin with: eight labelled buttons down the side of a phone
 * is most of the screen spent on furniture. The hamburger is the whole of the
 * navigation until someone asks for it.
 */
function setRail(open, { remember = true } = {}) {
  document.documentElement.classList.toggle('rail-closed', !open);
  $('#scrim').hidden = !open;
  const btn = $('#railToggle');
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', open ? 'Hide navigation' : 'Show navigation');
  // Closing it because the view changed on a phone is not a preference.
  if (remember && Store.state.settings.railOpen !== open) {
    Store.commit((st) => { st.settings.railOpen = open; });
  }
}

function wireRail() {
  /* Open beside the content where there is room, behind the hamburger where
     there is not — which is what the source design does, and what makes both
     "nav on the left" and "shrunk to three bars" true at once. Once someone
     has opened or closed it themselves, that choice wins at every width. */
  const chosen = Store.state.settings.railOpen;
  setRail(chosen === null || chosen === undefined ? window.innerWidth >= 900 : chosen, { remember: false });
  $('#scrim').addEventListener('click', () => setRail(false));
  $('#railToggle').addEventListener('click', () => {
    const opening = document.documentElement.classList.contains('rail-closed');
    setRail(opening);
    // Opening it with the keyboard should land you in it, not behind it.
    if (opening) $('.tab.is-active, .tab')?.focus();
  });
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.documentElement.classList.contains('rail-closed')) return;
    setRail(false);
    $('#railToggle').focus();
  });
}

function wireTabs() {
  wireRail();
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      switchView(tab.dataset.tab);
      // On a narrow screen the open rail is most of the width, so choosing a
      // view puts it away again; on a wide one there is room to leave it.
      if (window.innerWidth < 900) setRail(false, { remember: false });
      /* The timer commits on a minute's tick, so a learner who studies for
         forty seconds and comes back to Home would read "0 min" against ten
         reviews. Banking it here means the tile is true whenever it is
         looked at — outside the render, so committing cannot re-enter it. */
      if (tab.dataset.tab === 'home') { timer.flush(); timer.resume(); }
      if (tab.dataset.tab === 'progress') { renderProgress(Store.state); drawXp(Store.state); }
      if (tab.dataset.tab === 'practice') ensurePracticeSeed();
      if (tab.dataset.tab === 'modules') loadModules();
      if (tab.dataset.tab === 'home') drawHome(Store.state);
    });
  }
  $('#themeToggle').addEventListener('click', () => {
    const ids = THEMES.map((t) => t.id);
    setTheme(ids[(ids.indexOf(Store.state.settings.theme) + 1) % ids.length]);
  });
  labelTheme(Store.state.settings.theme);
}

// ── learn ──────────────────────────────────────────────────────────────────
function wireLearn() {
  $('#revealBtn').addEventListener('click', reveal);
  $('#studyAheadBtn').addEventListener('click', () => { session.ahead = true; nextCard(); });
  $('#speakBtn').addEventListener('click', () => speak(currentWord()?.term));
  $('#burySkipBtn').addEventListener('click', () => { session.queue.shift(); nextCard(); });

  for (const btn of $$('#grades .btn--grade')) {
    btn.addEventListener('click', () => gradeCard(Number(btn.dataset.grade)));
  }
  $('#explainBtn').addEventListener('click', aiCardHelp);
  $('#cardAsk').addEventListener('click', () => {
    const word = currentWord();
    if (!word) return;
    askAbout({
      about: `About “${word.term}”`,
      question: `I am studying "${word.term}"${word.definition ? ` — "${word.definition}"` : ''}. `
        + 'Explain it another way, and show me how it differs from a word people confuse it with.',
    });
  });
}

function refillQueue() {
  const state = Store.state;
  const usedToday = state.days[dayKey()]?.learned || 0;
  session.queue = buildQueue(state, {
    newAllowance: Math.max(0, state.settings.newPerDay - usedToday),
    ahead: session.ahead,
  });
}

function nextCard() {
  if (!session.queue.length) refillQueue();
  session.currentId = session.queue[0] || null;
  session.revealed = false;
  session.shownAt = Date.now();
  drawCurrentCard();
  renderQueueSummary(Store.state);
}

/** Fill the translation line under the definition, if a language is chosen. */
async function showTranslation(word) {
  const line = $('#cardTranslation');
  if (!word || !Translate.active) { line.hidden = true; return; }

  const info = Translate.info();
  line.hidden = false;
  line.textContent = '…';
  line.dir = info?.rtl ? 'rtl' : 'ltr';
  line.dataset.source = '';

  const result = await Translate.word(word);
  // The card may have moved on while the request was in flight.
  if (session.currentId !== word.id) return;
  if (!result) { line.hidden = true; return; }
  line.textContent = result.text;
  line.dataset.source = result.source;
}

function drawCurrentCard() {
  const state = Store.state;
  if (!session.currentId || !state.words[session.currentId]) {
    if (!session.queue.length) refillQueue();
    session.currentId = session.queue[0] || null;
  }
  const word = currentWord();
  if (!word) { renderEmptyQueue(state); return; }
  renderCard(word, state.srs[word.id], { revealed: session.revealed });
  if (session.revealed) showTranslation(word);
}

function currentWord() {
  return Store.state.words[session.currentId];
}

function reveal() {
  session.revealed = true;
  drawCurrentCard();
}

/**
 * The last graded card, kept so it can be taken back.
 *
 * Pressing Easy on a card you did not actually know is the commonest mistake
 * anyone makes with spaced repetition, and it is expensive: the card leaves for
 * a month. Rather than reverse each of the six things grading writes — the
 * schedule, the day counters, the streak, XP, the log, the queue — this keeps a
 * copy of the four bits of state they touch and puts them back.
 */
let lastGrade = null;

/** Put the deck back exactly as it was before the last grade. */
function undoGrade() {
  const shot = lastGrade;
  if (!shot) return;
  lastGrade = null;
  clearTimeout(undoTimer);
  $('#undoBar').hidden = true;

  Store.commit((s) => restore(s, shot.state));
  session.queue = shot.queue;
  session.revealed = false;
  announce(`Undone. ${shot.term} is back.`);
  toast(`Undone — ${shot.term}`);
  nextCard();
  renderHeader(Store.state);
  render();
}

function gradeCard(grade) {
  const word = currentWord();
  if (!word || !session.revealed) return;

  const rec = Store.state.srs[word.id] || makeSrs();
  const wasNew = rec.state === 'new';
  const next = schedule(rec, grade);

  // The queue is the session's, not the store's, so it is kept alongside.
  lastGrade = { term: word.term, state: snapshot(Store.state, word.id), queue: [...session.queue] };
  Store.commit((s) => { s.srs[word.id] = next; });
  Store.bumpDay({ reviews: 1, correct: grade > 0 ? 1 : 0, learned: wasNew ? 1 : 0 });

  // Getting it wrong still pays: the point is to keep the cards turning.
  award(grade > 0 ? AWARDS.reviewCorrect : AWARDS.reviewWrong, { module: word.module });
  if (wasNew && grade > 0) award(AWARDS.wordLearned, { module: word.module });
  claimDailyBonuses();
  Store.logReview({
    wordId: word.id, grade, correct: grade > 0, mode: 'flashcard',
    ms: Date.now() - session.shownAt,
  });

  if (grade === 0) {
    // Failed cards go to the back of this session rather than disappearing.
    session.queue.shift();
    session.queue.push(word.id);
  } else {
    session.queue.shift();
  }

  /* Nothing is written to the screen when a card is graded — it just turns —
     so this is the only account of it anyone not watching the animation gets. */
  announce(`${['Again', 'Hard', 'Good', 'Easy'][grade]}. ${word.term} returns in ${spokenDelta(next.due - Date.now())}. ${session.queue.length} left.`);

  const s = summary(Store.state);
  if (s.today.reviews === Store.state.settings.dailyGoal) {
    toast(`Day's quota met — ${s.today.reviews} reviews`);
    Notifier.show('Quota met', `${s.today.reviews} reviews today. Streak: ${s.streak} days.`, { actions: false });
  }

  nextCard();
  renderHeader(Store.state);
  showUndo(word.term);
}

/** Offer the undo, and take the offer away once the moment has passed. */
let undoTimer = null;
function showUndo(term) {
  const bar = $('#undoBar');
  if (!bar) return;
  $('#undoWhat').textContent = term;
  bar.hidden = false;
  clearTimeout(undoTimer);
  // Long enough to notice the mistake, short enough not to sit there all session.
  undoTimer = setTimeout(() => { bar.hidden = true; lastGrade = null; }, 12000);
}

/** The dagger buttons on the back of a card. */
/**
 * One button, one panel. It fills with the meaning in plainer words, the
 * examples we hold, and a memory hook — from the device, or from Claude when
 * the proxy is connected. Any examples that come back are kept on the card.
 */
async function aiCardHelp() {
  const word = currentWord();
  if (!word) return;
  const slot = $('#aiSlot');
  const body = $('#aiSlotBody');
  const btn = $('#explainBtn');
  slot.hidden = false;
  $('#aiSlotTitle').textContent = AIClient.engine;
  $('#aiSlot').title = AIClient.engineDetail;
  body.textContent = '';
  body.classList.add('cursor');
  btn.disabled = true;

  try {
    await AIClient.explain(word, (t) => { body.textContent += t; },
      { level: Store.state.profile.level });
    if (!(word.examples || []).length) {
      const data = await AIClient.enrichWord(word.term, { level: Store.state.profile.level })
        .catch(() => null);
      const examples = (data?.examples || []).slice(0, 3);
      if (examples.length) Store.updateWord(word.id, { examples });
    }
  } catch (err) {
    body.textContent = '';
    $('#aiSlotTitle').textContent = 'Built-in tutor';
    await AIClient.offlineExplain(word, (t) => { body.textContent += t; },
      { level: Store.state.profile.level })
      .catch(() => { body.textContent = `Could not reach ${AIClient.engine}: ${err.message}`; });
    toast(`${AIClient.engine} unreachable — answered on this device.`, 'bad');
  } finally {
    body.classList.remove('cursor');
    btn.disabled = false;
  }
}

// ── practice ───────────────────────────────────────────────────────────────
function wirePractice() {
  for (const btn of $$('#practiceModes .seg__btn')) {
    btn.addEventListener('click', () => {
      session.practiceMode = btn.dataset.mode;
      for (const b of $$('#practiceModes .seg__btn')) b.classList.toggle('is-active', b === btn);
      $('#quizCard').hidden = btn.dataset.mode !== 'quiz';
      $('#typeCard').hidden = btn.dataset.mode !== 'type';
      $('#coachCard').hidden = btn.dataset.mode !== 'coach';
      ensurePracticeSeed();
    });
  }

  $('#quizStart').addEventListener('click', nextQuiz);
  $('#typeStart').addEventListener('click', nextSpell);
  $('#typeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkSpelling(); });
  $('#undoBtn').addEventListener('click', undoGrade);
  $('#coachSubmit').addEventListener('click', runCoach);
  $('#coachNew').addEventListener('click', pickCoachWord);
  /* A correction you disagree with is the other moment a learner wants to
     ask something, and the panel used to end the conversation. */
  $('#coachAsk').addEventListener('click', () => {
    const word = Store.state.words[session.coachWordId];
    const sentence = $('#coachInput').value.trim();
    if (!word) return;
    askAbout({
      about: `About my sentence with “${word.term}”`,
      question: `I wrote: "${sentence}"\n\nusing the word "${word.term}"`
        + `${word.definition ? ` ("${word.definition}")` : ''}. `
        + 'What would a native speaker have written instead, and why?',
    });
  });
}

function ensurePracticeSeed() {
  if (session.practiceMode === 'coach' && !session.coachWordId) pickCoachWord();
}

async function nextQuiz() {
  const pool = practicePool(Store.state, 12);
  if (pool.length < 4) { toast('Add at least four words first.', 'bad'); return; }

  const word = pool[Math.floor(Math.random() * Math.min(6, pool.length))];
  $('#quizStart').disabled = true;
  $('#quizPrompt').textContent = 'Building a question…';
  $('#quizFeedback').hidden = true;
  $('#quizOptions').replaceChildren();

  let item;
  try {
    item = await AIClient.quiz(word, pool, { level: Store.state.profile.level });
  } catch (err) {
    toast(err.message, 'bad');
    item = fallbackQuiz(word, pool);
  }

  session.quiz = { wordId: word.id, ...item };
  $('#quizPrompt').textContent = item.question;
  $('#quizOptions').replaceChildren(...item.options.map((opt, i) =>
    el('button', { class: 'option', text: opt, onclick: () => answerQuiz(i) })));
  const startBtn = $('#quizStart');
  startBtn.disabled = false;
  startBtn.textContent = 'Skip';
  startBtn.classList.replace('btn--primary', 'btn--quiet');
}

function fallbackQuiz(word, pool) {
  const others = pool.filter((w) => w.id !== word.id).slice(0, 3).map((w) => w.term);
  const options = [...others, word.term].sort(() => Math.random() - 0.5);
  return {
    question: word.definition || `Which word is “${word.term}”?`,
    options,
    answerIndex: options.indexOf(word.term),
    explanation: word.definition || '',
  };
}

function answerQuiz(index) {
  const q = session.quiz;
  if (!q) return;
  const correct = index === q.answerIndex;

  for (const [i, btn] of $$('#quizOptions .option').entries()) {
    btn.disabled = true;
    // Mark the outcome with a glyph as well as colour — colour alone is not a
    // signal everyone can read.
    if (i === q.answerIndex) { btn.classList.add('is-correct'); btn.append(icon('check')); }
    else if (i === index) { btn.classList.add('is-wrong'); btn.append(icon('close')); }
  }

  recordPractice(q.wordId, correct, 'quiz');

  const fb = $('#quizFeedback');
  fb.hidden = false;
  fb.className = `feedback ${correct ? 'is-ok' : 'is-bad'}`;
  fb.textContent = correct
    ? `Correct. ${q.explanation || ''}`.trim()
    : `Not quite — the answer is “${q.options[q.answerIndex]}”. ${q.explanation || ''}`.trim();

  setTimeout(nextQuiz, correct ? 900 : 2200);
}

function nextSpell() {
  const pool = practicePool(Store.state, 12);
  if (!pool.length) { toast('Add a word first.', 'bad'); return; }
  const word = pool[Math.floor(Math.random() * pool.length)];
  session.spell = { wordId: word.id };

  $('#typePrompt').textContent = word.definition || `Spell the word you heard.`;
  $('#typeInput').value = '';
  $('#typeInput').disabled = false;
  $('#typeInput').focus();
  $('#typeFeedback').hidden = true;
  $('#typeStart').textContent = 'Skip';
  $('#typeStart').classList.replace('btn--primary', 'btn--quiet');
  speak(word.term);
}

function checkSpelling() {
  const s = session.spell;
  if (!s) return;
  const word = Store.state.words[s.wordId];
  const guess = $('#typeInput').value.trim().toLowerCase();
  if (!guess) return;
  const correct = guess === word.term.toLowerCase();

  recordPractice(word.id, correct, 'spell');

  const fb = $('#typeFeedback');
  fb.hidden = false;
  fb.className = `feedback ${correct ? 'is-ok' : 'is-bad'}`;
  fb.textContent = correct ? `Correct — ${word.term}.` : `You wrote “${guess}”. It is “${word.term}”.`;
  $('#typeInput').disabled = true;
  setTimeout(nextSpell, correct ? 900 : 2400);
}

/**
 * Practice answers count as reviews for tracking, but they do not reschedule a
 * card — only the Learn tab moves cards through the SRS. A wrong answer does
 * pull the card forward so it resurfaces in the next Learn session.
 */
function recordPractice(wordId, correct, mode) {
  Store.bumpDay({ reviews: 1, correct: correct ? 1 : 0 });
  Store.logReview({ wordId, correct, grade: correct ? 2 : 0, mode });
  if (correct) award(mode === 'spell' ? AWARDS.spellCorrect : AWARDS.quizCorrect,
                     { module: Store.state.words[wordId]?.module });
  claimDailyBonuses();
  if (!correct) {
    Store.commit((s) => {
      const rec = s.srs[wordId];
      if (rec && rec.state !== 'new') rec.due = Math.min(rec.due, Date.now());
    });
  }
  renderHeader(Store.state);
  renderQueueSummary(Store.state);
}

function pickCoachWord() {
  const pool = practicePool(Store.state, 10);
  if (!pool.length) return;
  const word = pool[Math.floor(Math.random() * pool.length)];
  session.coachWordId = word.id;
  $('#coachWord').textContent = word.term;
  $('#coachInput').value = '';
  $('#coachSlot').hidden = true;
  $('#coachOutput').textContent = '';
}

async function runCoach() {
  const word = Store.state.words[session.coachWordId];
  const sentence = $('#coachInput').value.trim();
  if (!word) return;
  if (sentence.length < 6) { toast('Write a full sentence first.', 'bad'); return; }

  const out = $('#coachOutput');
  $('#coachSlot').hidden = false;
  $('#coachSlot').title = AIClient.engineDetail;
  $('#coachSlotTitle').textContent = AIClient.engine;
  out.textContent = '';
  out.classList.add('cursor');
  $('#coachSubmit').disabled = true;

  try {
    await AIClient.coach({
      term: word.term, definition: word.definition, sentence,
      level: Store.state.profile.level,
    }, (t) => { out.textContent += t; });
    Store.logReview({ wordId: word.id, correct: true, grade: 2, mode: 'coach' });
    Store.bumpDay({ reviews: 1, correct: 1 });
    award(AWARDS.sentenceCoached, { module: word.module });
    claimDailyBonuses();
    renderHeader(Store.state);
  } catch (err) {
    out.textContent = `Could not reach ${AIClient.engine}: ${err.message}`;
  } finally {
    out.classList.remove('cursor');
    $('#coachSubmit').disabled = false;
  }
}

/**
 * The header search.
 *
 * It hands off to the Words tab, which already filters the deck and can look a
 * word up in the shipped dictionary — so this is a shortcut to that from
 * wherever you are, not a second search that would drift out of step with it.
 */
function wireTopSearch() {
  const go = () => {
    const q = $('#topSearch').value.trim();
    if (!q) return;
    session.wordQuery = q;
    $('#wordSearch').value = q;
    switchView('words');
    refreshWordList();
  };
  $('#topSearchForm').addEventListener('submit', (e) => { e.preventDefault(); go(); });
  // Typing straight into it should filter as you go, as the design's does.
  $('#topSearch').addEventListener('input', () => {
    if ($('#topSearch').value.trim()) go();
  });
}

// ── words ──────────────────────────────────────────────────────────────────
function wireWords() {
  $('#addWordBtn').addEventListener('click', addWord);
  $('#addWordInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWord(); });
  $('#wordSearch').addEventListener('input', (e) => {
    session.wordQuery = e.target.value;
    refreshWordList();
  });
  $('#wordFilter').addEventListener('change', (e) => {
    session.wordFilter = e.target.value;
    refreshWordList();
  });
  $('#suggestBtn').addEventListener('click', suggestWords);
}

// ── home ───────────────────────────────────────────────────────────────────
function wireHome() {
  $('#homeStart').addEventListener('click', () => { switchView('learn'); nextCard(); });
  $('#homePractice').addEventListener('click', () => { switchView('practice'); ensurePracticeSeed(); });
  // "See all" on the modules card is the one route to the module list from
  // here; the Today card used to carry a second, and the rail a third.
  $('#homeModulesAll').addEventListener('click', () => { switchView('modules'); loadModules(); });
  $('#homeContinue').addEventListener('click', () => {
    const next = session.continueSet;
    if (next) startSet(next.module, next.index);
  });
}

/** What to do now, the habit behind it, where you stand, and the path you are on. */
function drawHome(state) {
  const s = summary(state);
  const goal = state.settings.dailyGoal;
  const doneToday = s.today.reviews;
  const xpToday = state.xp?.byDay?.[dayKey()] || 0;
  const week = windowStats(state, 7);
  const plan = plannedSession(state, { newAllowance: newLeftToday(state) });

  const days = state.streak.current || 0;
  $('#levelBadge').textContent = standing(state.xp?.total || 0).level;
  $('#navStreakTitle').textContent = days
    ? `${days} day${days === 1 ? '' : 's'} in a row`
    : 'Nothing learned yet';
  $('#navStreakNote').textContent = days
    ? `${s.studied} words learned, ${week.reviews} reviews this week.`
    : 'Ten words a day is twenty minutes, and 3,650 words a year.';

  renderHome({
    // The card carries two different measurements — the day's goal and the
    // queue waiting right now — and they are rarely the same number. Left
    // unlabelled beside each other ("20 reviews to go" over "Review 2 words")
    // they read as a bug, so the counter names its unit and the button names
    // exactly what pressing it will do.
    countLine: `${doneToday} of ${goal} reviews`
      + (xpToday ? ` · ${xpToday} XP` : ''),
    goalPct: goal ? Math.min(1, doneToday / goal) : 0,
    goalDone: doneToday >= goal && doneToday > 0,
    goalHint: doneToday >= goal && doneToday > 0
      ? 'Daily goal reached. Anything more is a bonus.'
      /* A backlog is only frightening when it is a surprise. The session serves
         the oldest first and stops at the ceiling, so this says what is coming
         rather than letting the number appear as a wall on the next screen. */
      : plan.waiting
        ? `${plan.waiting + plan.total} words are overdue. This session takes the ${plan.total} oldest; the rest follow over the next few days.`
        : '',
    startLabel: startLabel(plan),

    streak: state.streak.current || 0,
    week: { reviews: week.reviews },
    days: recentDays(state, 7),
    xp: { ...standing(state.xp?.total || 0), total: state.xp?.total || 0 },
    mods: startedModules(state),
    placement: state.placement || null,
    continue: session.continueSet
      ? { label: `Continue — ${session.continueSet.module.title}, set ${session.continueSet.index + 1}` }
      : null,
    stats: statLine(s, state),

    hero: heroLine(state, s, plan),
    stats4: fourNumbers(state),
    recent: recentRows(state, 6),
  }, { onModule: openModuleById, onWords: () => { switchView('words'); refreshWordList(); } });
}

/** The date, a greeting for the hour, what is waiting, and how far in we are. */
function heroLine(state, s, plan) {
  const now = new Date();
  const hour = now.getHours();
  // Days studied, not days since the install: a fortnight away should not
  // advance the counter, and the first day is earned by turning up.
  const day = activeDays(state);

  return {
    date: now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    greeting: hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.',
    // The line under the greeting is the only place that says what is actually
    // waiting, so it says the number rather than a mood.
    sub: readyNow(plan)
      ? `${readyNow(plan)} word${readyNow(plan) === 1 ? '' : 's'} ready for review.`
      : plan.new
        ? 'Ready to learn a few words?'
        : s.studied
          ? 'Nothing is due. Practise ahead, or take the day.'
          : 'Open a module and meet your first ten words.',
    journey: day
      ? `Your learning journey · Day ${day}`
      : 'Your learning journey starts today',
  };
}

/** The four tiles, as the strings they are printed as. */
function fourNumbers(state) {
  const d = dashboard(state);
  return {
    words: d.words.toLocaleString(),
    mastery: `${Math.round(d.mastery * 100)}%`,
    streak: String(d.streak),
    // Under a minute it says the seconds: "0 min" after a real session that
    // just started reads as though nothing was counted.
    time: d.seconds && d.seconds < 60
      ? `${d.seconds} sec`
      : `${Math.round(d.seconds / 60)} min`,
  };
}

const STATE_LABEL = {
  new: 'Not started', learning: 'Learning', review: 'Reviewing',
  mastered: 'Mastered', leech: 'Needs work',
};

/** The recent rows, each carrying the word its state is named in. */
function recentRows(state, n) {
  return recentlyLearned(state, n)
    .map((row) => ({ ...row, stateLabel: STATE_LABEL[row.state] || row.state }));
}

/**
 * One line where four tiles used to be.
 *
 * The tiles showed This week / This month / Streak / Words learned, three of
 * which now live in the cards above, and on a fresh install all four read "0" —
 * four boxes of nothing.
 */
function statLine(s, state) {
  const month = windowStats(state, 30);
  // The header already carries "N words · N learned" on every screen, and the
  // card above carries the current streak — so this adds the longer view
  // instead of repeating either.
  const parts = [`${month.reviews} review${month.reviews === 1 ? '' : 's'} this month`];
  if (s.accuracy7 != null) parts.push(`${Math.round(s.accuracy7 * 100)}% accurate this week`);
  if (s.longest) parts.push(`best streak ${s.longest} day${s.longest === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Modules the learner has actually started, best progress first.
 *
 * `state.lessons` is the record of sets attempted, keyed by module, so it is
 * the honest answer to "what am I working on" — the deck alone cannot say,
 * because words from a passed set are indistinguishable from words added by
 * hand.
 */
function startedModules(state) {
  const lessons = state.lessons || {};
  const started = Object.entries(lessons)
    .map(([id, sets]) => {
      const entry = moduleManifest.find((m) => m.id === id);
      if (!entry) return null;
      const results = Object.values(sets);
      return {
        id,
        title: entry.title,
        level: entry.level || '',
        started: true,
        done: results.filter((r) => r?.passed).length,
        sets: Math.ceil((entry.count || 0) / SET_WORDS) || results.length,
        at: Math.max(0, ...results.map((r) => r?.at || 0)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, 4);

  /* Below three rows the card is mostly empty, and the thing a learner with
     one module needs is the next one — so the rest of the row is filled with
     packs they have not opened, nearest their own level first. */
  if (started.length >= 3) return started;
  const level = state.profile.level;
  const rest = moduleManifest
    .filter((m) => !lessons[m.id])
    .sort((a, b) => matchesLevel(b, level) - matchesLevel(a, level))
    .slice(0, 3 - started.length)
    .map((m) => ({
      id: m.id,
      title: m.title,
      level: m.level || '',
      started: false,
      done: 0,
      sets: Math.ceil((m.count || 0) / SET_WORDS),
      at: 0,
    }));
  return [...started, ...rest];
}

/** 1 when a pack's CEFR band contains the learner's own, 0 otherwise. */
function matchesLevel(entry, level) {
  return level && (entry.level || '').includes(level) ? 1 : 0;
}

/**
 * What the primary button will actually do, said in the button.
 *
 * "Start learning" was a label for three different outcomes — reviewing what is
 * due, meeting new words, or studying ahead of schedule — and gave the learner
 * no way to know which they were about to get.
 *
 * The new-word count is the number the session will really serve, not the
 * number sitting in the deck: buildQueue caps new cards at the daily allowance,
 * so a fresh install offered "Learn 40 new words" and then handed over ten.
 */
function startLabel(plan) {
  const waiting = readyNow(plan);
  if (waiting) return `Review ${waiting} word${waiting === 1 ? '' : 's'}`;
  if (plan.new) return `Learn ${plan.new} new word${plan.new === 1 ? '' : 's'}`;
  return 'Study ahead';
}

/**
 * Cards waiting right now: everything overdue plus the learning cards that
 * have come round again.
 *
 * The greeting and the button both name this number, and they used to count it
 * differently — "16 words are ready for review" over a button reading "Review
 * 24 words" reads as a bug, whichever one is right.
 */
function readyNow(plan) {
  return plan.due + plan.learning;
}

/** New cards still allowed today, after the ones already introduced. */
function newLeftToday(state) {
  const used = state.days[dayKey()]?.learned || 0;
  return Math.max(0, state.settings.newPerDay - used);
}

// ── modules ────────────────────────────────────────────────────────────────
function wireModules() {
  $('#moduleBack').addEventListener('click', () => { switchView('modules'); loadModules(); });
}

/** Fetch the manifest, then each pack only to count what is already in the deck. */
let moduleManifest = [];
/** id -> { Easy: n, Moderate: n, … }, so the plan can rank modules by difficulty. */
let moduleBands = {};

async function loadModules() {
  const node = $('#moduleList');
  try {
    const manifest = await Catalog.modules();
    moduleManifest = manifest;
    const rows = await Promise.all(manifest.map(async (m) => {
      const pack = await Catalog.pack(m.id);
      const sets = chunk(pack.words, SET_WORDS);
      const results = setResults(m.id);
      moduleBands[m.id] = tallyBands(pack.words);
      return {
        ...m,
        sets: sets.length,
        setsDone: sets.filter((_, i) => results[i]?.passed).length,
      };
    }));
    renderModules(rows, { onOpen: openModule });
    rememberContinue(rows);
  } catch (err) {
    node.replaceChildren(el('p', { class: 'hint', text: `Could not load the modules: ${err.message}` }));
  }
}

/** How many words of each difficulty band a pack holds. */
function tallyBands(words) {
  const mix = {};
  for (const w of words) if (w.x) mix[w.x] = (mix[w.x] || 0) + 1;
  return mix;
}

/** Open one module and show its sets. */
async function openModule(module) {
  if (!module) return false;
  const entry = moduleManifest.find((m) => m.id === module.id) || module;
  const pack = await Catalog.pack(entry.id);
  const sets = chunk(pack.words.map(toWordRecord(entry.id)), SET_WORDS);
  session.module = entry;
  session.sets = sets;
  renderModuleDetail({ ...entry, count: pack.words.length }, sets, setResults(entry.id), {
    onStart: (index) => startSet(entry, index),
  });
  switchView('module');
  return true;
}

/** Study set `index` of a module: its ten words, then the exam. */
async function startSet(module, index) {
  const pack = await Catalog.pack(module.id);
  const words = chunk(pack.words.map(toWordRecord(module.id)), SET_WORDS);
  if (index >= words.length) { openModule(module); return; }
  const pool = pack.words.slice(0, 60).map(toWordRecord(module.id));
  startLesson(module, index, words[index], pool);
}

/** Dataset entry → the word shape the rest of the app uses. */
const toWordRecord = (moduleId) => (entry) => ({
  id: entry.w,
  term: entry.w,
  phonetic: '',
  pos: entry.p || '',
  definition: entry.d || '',
  examples: entry.e || [],
  synonyms: entry.s || [],
  antonyms: [],
  mnemonic: '',
  tags: [moduleId],
  level: { Easy: 'A2', Moderate: 'B1', Advanced: 'B2', 'God Level': 'C2' }[entry.x] || '',
  tr: { bn: entry.bn || '', hi: entry.hi || '', 'zh-CN': entry.zh || '' },
  source: `module:${moduleId}`,
  module: moduleId,
});

/** The first unfinished set, for the home screen's Continue button. */
function rememberContinue(rows) {
  for (const row of rows) {
    const results = setResults(row.id);
    if (!row.setsDone && !Object.keys(results).length) continue;
    const next = Array.from({ length: row.sets }, (_, i) => i).find((i) => !results[i]?.passed);
    if (next !== undefined) {
      session.continueSet = { module: row, index: next, total: row.sets };
      return;
    }
  }
  session.continueSet = null;
}

function refreshWordList() {
  renderWordList(Store.state,
    { query: session.wordQuery, filter: session.wordFilter },
    { onOpen: openWord, onMenu: wordMenu });
}

async function addWord() {
  const input = $('#addWordInput');
  const term = input.value.trim();
  const hint = $('#addWordHint');
  if (!term) return;

  if (Store.hasWord(term)) { toast(`“${term}” is already in your deck.`, 'bad'); return; }

  const useAI = $('#addWithAI').checked;
  input.disabled = true;
  hint.textContent = useAI ? `Asking ${AIClient.engine} for a definition…` : '';

  try {
    // 117,000 words ship with the app, so most additions never need the network.
    const known = await Catalog.lookup(term).catch(() => null);
    const payload = known
      ? known
      : useAI
        ? await AIClient.enrichWord(term, { level: Store.state.profile.level })
        : { term };
    Store.addWord({ ...payload, term }, known ? 'dictionary' : useAI ? `ai:${AIClient.mode}` : 'user');
    toast(known ? `Added “${term}” from the dictionary.` : `Added “${term}”.`);
    input.value = '';
    hint.textContent = '';
    refillQueue();
    render();
  } catch (err) {
    hint.textContent = `Saved without AI details — ${err.message}`;
    Store.addWord({ term }, 'user');
    render();
  } finally {
    input.disabled = false;
    input.focus();
  }
}

function openWord(word) {
  session.queue = [word.id, ...session.queue.filter((id) => id !== word.id)];
  session.currentId = word.id;
  session.revealed = true;
  session.shownAt = Date.now();
  switchView('learn');
  drawCurrentCard();
}

function wordMenu(word) {
  actionSheet(`${word.term} — ${bucket(Store.state.srs[word.id])}`, [
    { label: 'Study this word now', icon: 'study', run: () => openWord(word) },
    { label: 'Ask the tutor about it', icon: 'bulb', run: () => askAbout({
      about: `About “${word.term}”`,
      question: `Explain "${word.term}" to me${word.definition ? ` — I have it down as "${word.definition}"` : ''}. Give me one example sentence I would actually use.`,
    }) },
    { label: 'Explain it again', icon: 'bulb', run: () => refreshWithAI(word) },
    { label: 'Start it over', icon: 'back', run: () => {
      Store.commit((s) => { s.srs[word.id] = makeSrs(); });
      toast('Progress reset.');
      render();
    } },
    { label: 'Delete', icon: 'trash', danger: true, run: () => {
      if (!confirm(`Delete “${word.term}” and its progress?`)) return;
      Store.deleteWord(word.id);
      render();
    } },
  ]);
}

async function refreshWithAI(word) {
  toast(`Asking ${AIClient.engine}…`);
  try {
    const data = await AIClient.enrichWord(word.term, { level: Store.state.profile.level });
    Store.updateWord(word.id, { ...data, term: word.term });
    toast(`Updated “${word.term}”.`);
    render();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function suggestWords() {
  const btn = $('#suggestBtn');
  const label = $('#suggestLabel');
  btn.disabled = true;
  label.textContent = 'Thinking…';
  try {
    const items = await AIClient.suggest({
      level: Store.state.profile.level,
      known: Object.values(Store.state.words).slice(-40).map((w) => w.term),
      struggling: weakest(Store.state, 5).map((w) => w.term),
      count: 6,
    });
    renderSuggestions(items, async (item) => {
      if (Store.hasWord(item.term)) { toast('Already in your deck.'); return; }
      const data = await AIClient.enrichWord(item.term, { level: Store.state.profile.level })
        .catch(() => ({ term: item.term, definition: item.reason }));
      Store.addWord({ ...data, term: item.term }, `ai:${AIClient.mode}`);
      toast(`Added “${item.term}”.`);
      render();
    });
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    btn.disabled = false;
    label.textContent = 'Suggest six';
  }
}

// ── install ────────────────────────────────────────────────────────────────

/**
 * Offering the app as an app.
 *
 * Chrome and Edge can install in one tap; Safari cannot install at all and
 * needs the learner to find Share → Add to Home Screen; Firefox does not do it
 * on the desktop. So the offer is whatever that platform can genuinely do, and
 * where there is no button there are words instead.
 */
let installer = null;

function wireInstall() {
  installer = createInstaller({ onChange: drawInstall });

  $('#installGo').addEventListener('click', runInstall);
  $('#navInstallGo').addEventListener('click', runInstall);
  $('#homeInstallGo').addEventListener('click', runInstall);
  $('#homeInstallClose').replaceChildren(icon('close'));
  $('#homeInstallClose').addEventListener('click', () => {
    // Asked once. Someone who said no does not want it every time they open
    // the app, and the offer stays in Settings for whenever they change mind.
    Store.set('settings.installDismissed', true);
    drawInstall();
  });

  drawInstall();
}

async function runInstall() {
  const outcome = await installer.prompt();
  if (outcome === 'accepted') toast('Installing — look for VocabX with your other apps.');
  else if (outcome === 'dismissed') toast('No problem — it is in Settings when you want it.');
  else toast('Your browser cannot install from here. The steps are in Settings.', 'bad');
}

function drawInstall(state = installer?.state()) {
  if (!state) return;
  renderInstall(state, {
    dismissed: Boolean(Store.state.settings.installDismissed),
    downloads: DOWNLOADS,
  });
}

/**
 * Files offered for download, by platform.
 *
 * Relative to the app, so they work wherever the app is hosted; a link is only
 * shown once its file is actually reachable, or a fresh checkout would offer a
 * 404.
 */
const DOWNLOADS = [
  { os: 'windows', label: 'Windows download', href: '../download/vocabx-windows.zip',
    note: 'Unzip and run VocabX.exe. No browser install, no runtime.' },
];

// ── feedback ───────────────────────────────────────────────────────────────

/**
 * The feedback sheet.
 *
 * Feedback is kept on the device and sent to your proxy when one is configured.
 * There is no third-party form and no analytics: this app collects nothing, and
 * a feedback button is not a good reason to start.
 *
 * "Copy it instead" is the escape hatch for anyone with no server — the report
 * lands on the clipboard, with the context that makes it actionable, and they
 * can paste it wherever they like.
 */
let feedbackKind = 'idea';

function wireFeedback() {
  $('#feedbackBtn').addEventListener('click', openFeedback);
  $('#feedbackCancel').addEventListener('click', closeFeedback);
  $('#feedbackSheet').addEventListener('click', (e) => {
    if (e.target === $('#feedbackSheet')) closeFeedback();
  });
  for (const btn of $$('#feedbackKind .seg__btn')) {
    btn.addEventListener('click', () => {
      feedbackKind = btn.dataset.kind;
      for (const b of $$('#feedbackKind .seg__btn')) b.classList.toggle('is-active', b === btn);
    });
  }
  $('#feedbackSend').addEventListener('click', sendFeedback);
  $('#feedbackMail').addEventListener('click', mailFeedback);
  $('#feedbackCopy').addEventListener('click', copyFeedback);
}

function openFeedback() {
  $('#feedbackSheet').hidden = false;
  /* Be exact about where it lands. "Send" without a proxy only ever wrote the
     note to this device, which read as sent and was not. */
  $('#feedbackNote').textContent = AIClient.isLive
    ? `Send goes to your own server, which can forward it to ${APP.feedbackTo}.`
    : `Send only saves it on this device — no server is connected. Use “Send by email instead” to reach ${APP.feedbackTo}.`;
  $('#feedbackText').focus();
}

const closeFeedback = () => { $('#feedbackSheet').hidden = true; };

/**
 * The report, with the context that makes it useful.
 *
 * Which screen, which engine and which level turn "the quiz is broken" into
 * something reproducible. No deck contents and nothing identifying.
 */
function feedbackReport() {
  const text = $('#feedbackText').value.trim();
  return {
    kind: feedbackKind,
    text,
    from: $('#feedbackFrom').value.trim(),
    at: new Date().toISOString(),
    context: {
      view: location.hash.replace('#', '') || 'home',
      provider: AIClient.provider,
      level: Store.state.profile.level,
      words: Object.keys(Store.state.words).length,
      screen: `${window.innerWidth}x${window.innerHeight}`,
      version: APP.storageKey,
    },
  };
}

async function sendFeedback() {
  const report = feedbackReport();
  if (!report.text) { toast('Write something first.', 'bad'); return; }

  Store.commit((s) => { (s.feedback ||= []).push(report); s.feedback = s.feedback.slice(-50); });

  if (!AIClient.isLive) {
    closeFeedback();
    $('#feedbackText').value = '';
    toast('Saved on this device — copy it to send it on.');
    return;
  }
  const btn = $('#feedbackSend');
  btn.disabled = true;
  try {
    const res = await fetch(AIClient.url('/api/feedback'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    if (!res.ok) throw new Error(`server responded ${res.status}`);
    toast('Thank you — sent.');
    $('#feedbackText').value = '';
    $('#feedbackFrom').value = '';
    closeFeedback();
  } catch (err) {
    toast(`Kept on this device — ${err.message}.`, 'bad');
    closeFeedback();
  } finally {
    btn.disabled = false;
  }
}

/**
 * Hand the note to the mail app.
 *
 * Without a proxy, "Send" can only keep the note on the device, and a note
 * nobody reads is not feedback. A mailto: works with no server at all, and it
 * leaves the learner in control of what is sent.
 */
function mailFeedback() {
  const report = feedbackReport();
  if (!report.text) { toast('Write something first.', 'bad'); return; }
  Store.commit((s) => { (s.feedback ||= []).push(report); s.feedback = s.feedback.slice(-50); });
  location.href = feedbackMailto(report, APP.feedbackTo);
  closeFeedback();
  $('#feedbackText').value = '';
  $('#feedbackFrom').value = '';
  toast('Opening your mail app.');
}

async function copyFeedback() {
  const report = feedbackReport();
  if (!report.text) { toast('Write something first.', 'bad'); return; }
  const lines = `${feedbackSubject(report)}\n\n${feedbackAsText(report)}`;
  try {
    await navigator.clipboard.writeText(lines);
    toast('Copied to the clipboard.');
  } catch {
    // Clipboard access is refused in some browsers without a user gesture it
    // recognises; showing the text is better than failing silently.
    $('#feedbackText').value = lines;
    $('#feedbackText').select();
    toast('Select and copy the text above.');
  }
}

// ── test ───────────────────────────────────────────────────────────────────

/**
 * The Test section: subject → pack → mode → round.
 *
 * Held in one object rather than five, so quitting halfway leaves nothing
 * behind and "Change test" is a single reset.
 */
const lab = {
  subject: null, pack: null, mode: null,
  questions: [], at: 0, answers: [], checked: false,
  grammar: null,
};

function wireTest() {
  $('#testBackSubject').addEventListener('click', () => showTestStep('subject'));
  $('#testBackPack').addEventListener('click', () =>
    showTestStep(lab.subject === 'grammar' ? 'subject' : 'pack'));
  $('#testQuit').addEventListener('click', () => showTestStep('subject'));
  $('#testChange').addEventListener('click', () => showTestStep('subject'));
  $('#testAgain').addEventListener('click', () => startRound(lab.subject, lab.pack, lab.mode));
  $('#testSubmit').addEventListener('click', checkAnswer);
  $('#testNext').addEventListener('click', nextTestQuestion);
  $('#testExplain').addEventListener('click', explainQuestion);
  /* A question you got wrong is the moment you most want to ask something, and
     it used to be the moment the app gave you nowhere to ask it. */
  $('#testAsk').addEventListener('click', () => {
    const q = lab.questions[lab.at];
    if (!q) return;
    const right = q.options?.[q.answerIndex] || q.accept?.[0] || q.definition || '';
    const grammar = q.subject === 'grammar';
    /* Only the multiple-choice and gap-fill modes have a "question" to quote.
       In flashcard and type mode the prompt is the word itself, and quoting a
       bare word back as a question reads like nonsense. */
    const asked = q.options?.length
      ? `I am practising ${grammar ? 'grammar' : 'vocabulary'} and got this question:\n\n"${q.prompt}"\n\n`
        + (right ? `The answer is "${right}". ` : '')
        + 'Explain why, simply, and give me one more example of the same point.'
      : `I am practising ${grammar ? 'grammar' : 'vocabulary'} and just met "${q.term || q.prompt}"`
        + `${right ? ` — "${right}"` : ''}. Explain it simply, and give me one example sentence.`;
    askAbout({
      about: grammar ? 'About a grammar question' : `About “${q.term || q.prompt}”`,
      question: asked,
    });
  });
  $('#testTypeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkAnswer(); });

  renderTestSubjects(SUBJECTS, (id) => {
    lab.subject = id;
    // Grammar has one shipped bank, so there is no pack to choose.
    if (id === 'grammar') { lab.pack = null; showTestStep('mode'); }
    else showTestStep('pack');
  });
}

/** Which panel of the Test tab is showing. */
function showTestStep(step) {
  $('#testPickSubject').hidden = step !== 'subject';
  $('#testPickPack').hidden = step !== 'pack';
  $('#testPickMode').hidden = step !== 'mode';
  $('#testRun').hidden = step !== 'run';
  $('#testResult').hidden = step !== 'result';

  if (step === 'pack') loadTestPacks();
  if (step === 'mode') {
    const name = lab.subject === 'grammar' ? 'Grammar' : (lab.pack?.title || 'Vocabulary');
    $('#testModeSub').textContent = `Testing: ${name}`;
    renderTestModes(modesFor(lab.subject), (id) => startRound(lab.subject, lab.pack, id));
  }
  switchView('test');
}

async function loadTestPacks() {
  try {
    const manifest = await Catalog.modules();
    moduleManifest = manifest;
    renderTestPacks(manifest, (pack) => { lab.pack = pack; showTestStep('mode'); });
  } catch (err) {
    toast(`Could not load the packs: ${err.message}`, 'bad');
  }
}

/** Build and start a round. */
async function startRound(subject, pack, mode) {
  lab.subject = subject; lab.pack = pack; lab.mode = mode;
  try {
    let words = [];
    let grammar = [];
    if (subject === 'grammar') {
      lab.grammar ??= await Catalog.grammar();
      grammar = lab.grammar;
    } else {
      words = (await Catalog.pack(pack.id)).words;
    }
    const questions = buildRound({ subject, mode, words, grammar });
    if (!questions.length) { toast('Not enough material for that test.', 'bad'); return; }
    lab.questions = questions;
    lab.at = 0;
    lab.answers = [];
    showTestStep('run');
    drawQuestion();
  } catch (err) {
    toast(`Could not start the test: ${err.message}`, 'bad');
  }
}

function drawQuestion() {
  lab.checked = false;
  renderTestQuestion(lab, (index) => {
    // A choice answers immediately; typed answers wait for Check.
    lab.answers[lab.at] = index;
    checkAnswer();
  });
}

function checkAnswer() {
  if (lab.checked) { nextTestQuestion(); return; }
  const q = lab.questions[lab.at];
  if (!q) return;

  if (q.kind === 'type') lab.answers[lab.at] = $('#testTypeInput').value;
  if (q.kind === 'write') lab.answers[lab.at] = $('#testWriteInput').value;
  if (q.kind === 'flashcard') lab.answers[lab.at] = null;

  lab.checked = true;
  const result = q.kind === 'flashcard' ? { correct: null } : markOne(q, lab.answers[lab.at]);
  showTestFeedback(q, result);
}

function nextTestQuestion() {
  lab.at += 1;
  if (lab.at >= lab.questions.length) { finishRound(); return; }
  drawQuestion();
}

function finishRound() {
  const result = markRound(lab.questions, lab.answers);
  // Flashcards carry no marks, so they earn nothing — saying "0%" after a
  // revision round would read as a failure rather than as "not a test".
  if (result.total > 0) {
    award(result.xp, { module: lab.pack?.id || 'grammar' });
    Store.bumpDay({ reviews: result.total, correct: result.correct });
    for (const q of lab.questions) {
      if (q.kind === 'flashcard') continue;
      Store.logReview({ wordId: q.term || q.topic, correct: true, grade: 2, mode: `test:${lab.mode}` });
    }
  }
  renderTestResult(lab, result);
  showTestStep('result');
  render();
}

/** "Explain this" — why the right answer is right. */
async function explainQuestion() {
  const q = lab.questions[lab.at];
  if (!q) return;
  const body = $('#testAiBody');
  const btn = $('#testExplain');
  $('#testAiSlot').hidden = false;
  $('#testAiTitle').textContent = q.subject === 'grammar' && q.why ? 'The rule' : AIClient.engine;
  $('#testAiSlot').title = AIClient.engineDetail;
  body.textContent = '';
  body.classList.add('cursor');
  btn.disabled = true;

  // A grammar item ships with its own rule, so it never needs the network.
  if (q.subject === 'grammar' && q.why) {
    body.textContent = q.why;
    body.classList.remove('cursor');
    btn.disabled = false;
    return;
  }
  try {
    await AIClient.ask({
      question: `In one short paragraph, explain the English word "${q.term}" and why it means what it does. Learner level ${Store.state.profile.level}.`,
      history: [], level: Store.state.profile.level,
    }, (t) => { body.textContent += t; });
  } catch (err) {
    body.textContent = `Could not reach ${AIClient.engine}: ${err.message}`;
  } finally {
    body.classList.remove('cursor');
    btn.disabled = false;
  }
}

// ── ask ────────────────────────────────────────────────────────────────────

/** The conversation. Lives for the session; nothing is sent anywhere but the proxy. */
const chat = { messages: [], busy: false };

function wireAsk() {
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sendQuestion($('#chatInput').value);
  });
  // The bar has to be re-measured whenever the chat becomes visible or the
  // window changes shape.
  window.addEventListener('resize', sizeChat);
  window.addEventListener('orientationchange', sizeChat);
  $('#chatStarters').replaceChildren(...STARTERS.map((q) =>
    el('button', { class: 'chip chip--tap', type: 'button', onclick: () => sendQuestion(q) }, q)));
  drawChatMode();
}

function drawChatMode() {
  $('#chatMode').textContent = AIClient.isLive
    ? `${AIClient.engineDetail} — ask anything about English.`
    : 'Answering from the dictionary on this device. Turn on Claude or Gemini in Settings for open questions.';
}

/**
 * Open the tutor on something you are already looking at.
 *
 * The chat used to be reachable only from its own tab, and only cold: a
 * learner reading a card, or one who had just got a test question wrong, had
 * to switch tabs and retype the word to ask about it. Every AI surface in the
 * app now hands off to here, and the subject travels with the question so the
 * tutor is told what you were on — and so the log shows it.
 */
function askAbout({ about, question }) {
  switchView('ask');
  sendQuestion(question, { about });
}

/** The subject of the follow-up, kept so the tutor keeps its thread. */
async function sendQuestion(text, { about = '' } = {}) {
  const question = String(text || '').trim();
  if (!question || chat.busy) return;

  $('#chatInput').value = '';
  $('#chatIntro').hidden = true;
  chat.busy = true;
  $('#chatSend').disabled = true;

  chat.messages.push({ role: 'you', text: question, about });
  /* Recorded on the reply rather than read off the setting when the log is
     drawn: the engine can be changed between one answer and the next, and a
     log that relabelled its history would be a lie about who wrote what. */
  const reply = { role: 'tutor', text: '', pending: true,
                  engine: AIClient.engine, engineDetail: AIClient.engineDetail };
  chat.messages.push(reply);
  drawChat();

  try {
    // The history is taken before the pending reply is appended, so the model
    // never sees its own half-written answer.
    const history = contextFor(chat.messages.slice(0, -2));
    await AIClient.ask({ question, history, level: Store.state.profile.level },
      (t) => { reply.text += t; drawChat(); });
    if (!reply.text) reply.text = 'No answer came back. Try again.';
  } catch (err) {
    /* The live engine could not be reached. The app ships 117,000 words and
       can very often answer this itself, so it does — and says so, rather
       than leaving a red line where the answer should be. */
    reply.text = '';
    try {
      await AIClient.offlineAnswer(question, (t) => { reply.text += t; drawChat(); });
      reply.engine = 'Built-in tutor';
      reply.engineDetail = 'Answered on this device';
      reply.note = `${AIClient.engine} could not be reached — ${err.message}`;
    } catch {
      reply.text = `Could not reach ${AIClient.engine}: ${err.message}`;
      reply.failed = true;
    }
  } finally {
    reply.pending = false;
    chat.busy = false;
    $('#chatSend').disabled = false;
    drawChat();
    $('#chatInput').focus();
  }
}

function drawChat() {
  renderChat(chat.messages);
}

// ── the level check ────────────────────────────────────────────────────────

/**
 * The placement exam, from intro to plan.
 *
 * The question pool is every module pack's words, which is where the difficulty
 * bands live — the dictionary shards carry no band, so they cannot be used to
 * measure anything. Packs are fetched once and cached by Catalog.
 */
let placementRun = null;
let placementPool = null;

function wireAssess() {
  $('#homeAssess').addEventListener('click', openAssess);
  $('#progressAssess').addEventListener('click', openAssess);
  $('#assessStart').addEventListener('click', beginPlacement);
  $('#assessRetake').addEventListener('click', beginPlacement);
  $('#assessShowLast').addEventListener('click', showLastPlacement);
  $('#assessQuit').addEventListener('click', () => {
    placementRun = null;
    switchView('home');
  });
  $('#assessApply').addEventListener('click', applyPlan);
}

function openAssess() {
  const last = Store.state.placement || null;
  $('#assessIntro').hidden = false;
  $('#assessExam').hidden = true;
  $('#assessResult').hidden = true;
  $('#assessLast').hidden = !last;
  if (last) {
    const when = new Date(last.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    $('#assessLastLine').textContent = `${last.level} on ${when} — ${last.correct} of ${last.answered} right.`;
  }
  switchView('assess');
}

/** Every banded word the app ships, loaded once. */
async function loadPlacementPool() {
  if (placementPool) return placementPool;
  const manifest = await Catalog.modules();
  moduleManifest = manifest;
  const packs = await Promise.all(manifest.map((m) => Catalog.pack(m.id)));
  // The plan ranks modules by how their difficulty mix sits against the
  // learner's level, so the tally has to exist before the result screen is
  // built. Doing it here as well as in loadModules() means the ranking is real
  // even if the Modules tab has never been opened — without it every module
  // scored identically and the "start with these" list was just manifest order.
  manifest.forEach((m, i) => { moduleBands[m.id] = tallyBands(packs[i].words); });
  placementPool = poolByBand(packs.flatMap((p) => p.words));
  return placementPool;
}

async function beginPlacement() {
  $('#assessStart').disabled = true;
  $('#assessStart').textContent = 'Loading the questions…';
  try {
    const pool = await loadPlacementPool();
    placementRun = startPlacement(pool);
    askPlacement();
  } catch (err) {
    toast(`Could not load the questions: ${err.message}`, 'bad');
  } finally {
    $('#assessStart').disabled = false;
    $('#assessStart').textContent = 'Start the check';
  }
}

function askPlacement() {
  const question = nextQuestion(placementRun);
  if (!question) { finishPlacement(); return; }
  renderPlacementQuestion(placementRun, question, markPlacement);
}

/**
 * Mark the answer, show it briefly, then move on. The delay is what makes the
 * exam feel like an exam rather than a form — and seeing the right answer is
 * the only teaching this screen does.
 */
function markPlacement(choice) {
  const question = placementRun.question;
  const result = answerPlacement(placementRun, choice);
  if (!result) return;

  const buttons = $$('#assessOptions .option');
  buttons.forEach((b, i) => {
    b.disabled = true;
    if (i === question.answerIndex) b.classList.add('is-correct');
    else if (i === choice) b.classList.add('is-wrong');
  });

  setTimeout(() => {
    if (!placementRun) return;
    if (placementDone(placementRun)) finishPlacement();
    else askPlacement();
  }, result.correct ? 420 : 900);
}

function finishPlacement() {
  const run = placementRun;
  placementRun = null;
  if (!run || !run.asked.length) { switchView('home'); return; }

  const sizes = Object.fromEntries(BANDS.map((b) => [b.id, (run.pool.get(b.id) || []).length]));
  const result = estimate(run, sizes);
  Store.set('placement', result);

  const plan = currentPlan(result);
  renderPlacementResult(result, plan, { onModule: openModuleById });
  renderLevelSummary(result);
  streamAssessment(result, plan);
  render();
}

/** The plan for a result, against what the learner is set to right now. */
function currentPlan(result) {
  const s = summary(Store.state);
  return buildPlan({
    estimate: result,
    manifest: moduleManifest,
    bandMix: moduleBands,
    accuracy: s.accuracy7,
    weak: weakest(Store.state, 8),
    current: {
      level: Store.state.profile.level,
      newPerDay: Store.state.settings.newPerDay,
      dailyGoal: Store.state.settings.dailyGoal,
    },
  });
}

/** The written read-out — built-in, or Claude when it is connected. */
async function streamAssessment(result, plan) {
  const body = $('#assessAnalysis');
  $('#assessSource').textContent = AIClient.engine;
  $('#assessSource').title = AIClient.engineDetail;
  body.textContent = '';
  body.classList.add('cursor');
  try {
    await AIClient.assess({
      estimate: result,
      plan: { level: plan.level, newPerDay: plan.newPerDay, dailyGoal: plan.dailyGoal,
              paceWhy: plan.paceWhy, modules: plan.modules.map((m) => ({ title: m.title, why: m.why })),
              revisit: plan.revisit, notes: plan.notes },
      deck: { size: Object.keys(Store.state.words).length, streak: Store.state.streak.current },
    }, (t) => { body.textContent += t; });
  } catch (err) {
    body.textContent = `Could not reach ${AIClient.engine}: ${err.message}`;
  } finally {
    body.classList.remove('cursor');
  }
}

function showLastPlacement() {
  const last = Store.state.placement;
  if (!last) return;
  const plan = currentPlan(last);
  renderPlacementResult(last, plan, { onModule: openModuleById });
  streamAssessment(last, plan);
}

/** One tap turns the measurement into settings. */
function applyPlan() {
  const result = Store.state.placement;
  if (!result) return;
  const plan = currentPlan(result);

  Store.set('profile.level', plan.level);
  Store.set('settings.newPerDay', plan.newPerDay);
  Store.set('settings.dailyGoal', plan.dailyGoal);

  // Settings is already built, so its controls have to be told.
  $('#levelSelect').value = plan.level;
  $('#newRange').value = plan.newPerDay;
  $('#newValue').textContent = plan.newPerDay;
  $('#goalRange').value = plan.dailyGoal;
  $('#goalValue').textContent = plan.dailyGoal;

  $('#assessApply').hidden = true;
  $('#assessApplied').hidden = false;
  $('#assessApplied').textContent = plan.changes.length
    ? `Applied: ${plan.changes.join(' · ')}.`
    : 'Your settings already matched the plan.';

  refillQueue();
  render();
  toast('Plan applied.');
}

async function openModuleById(module) {
  const entry = moduleManifest.find((m) => m.id === module.id);
  if (entry) await openModule(entry);
  else switchView('modules');
}

// ── progress ───────────────────────────────────────────────────────────────
function wireProgress() {
  $('#reportBtn').addEventListener('click', async () => {
    const out = $('#reportOutput');
    out.hidden = false;
    out.textContent = '';
    out.classList.add('cursor');
    try {
      await AIClient.report(reportPayload(Store.state), (t) => { out.textContent += t; });
    } catch (err) {
      out.textContent = `Could not reach the AI: ${err.message}`;
    } finally {
      out.classList.remove('cursor');
    }
  });
}

// ── settings ───────────────────────────────────────────────────────────────
function wireSettings() {
  const s = Store.state.settings;

  // reminders
  $('#notifyEnable').addEventListener('click', async () => {
    const result = await Notifier.request();
    if (result === 'granted') toast('Reminders on.');
    else if (result === 'denied') toast('Blocked in browser settings.', 'bad');
    refreshNotifyState();
  });
  // The test fires whatever the next step would say, so you see the real thing
  // rather than a placeholder that proves nothing about your routine.
  $('#notifyTest').addEventListener('click', async () => {
    const routine = sortRoutine(Store.state.settings.reminders.routine || []);
    const step = routine[0] || { id: 'test', time: '09:00', action: 'word' };
    const card = previewCard(step) || {
      title: 'VocabX', body: 'This is what a reminder looks like.', view: 'learn',
    };
    const sent = await Notifier.show(card.title, card.body,
      { data: { view: card.view }, actions: !card.quiet });
    if (!sent) toast('Turn on reminders first.', 'bad');
  });

  $('#newAction').replaceChildren(...Object.entries(ACTIONS).map(([id, a]) =>
    el('option', { value: id, text: a.label })));

  $('#addStepBtn').addEventListener('click', () => {
    const time = $('#newTime').value;
    if (!validTime(time)) { toast('Pick a time first.', 'bad'); return; }
    const step = makeStep(time, $('#newAction').value);
    Store.commit((st) => { st.settings.reminders.routine = [...(st.settings.reminders.routine || []), step]; });
    renderRoutine();
    Notifier.start();
    toast(`Added ${ACTIONS[step.action].label.toLowerCase()} at ${time}.`);
  });
  $('#pushToggle').addEventListener('change', async (e) => {
    try {
      if (e.target.checked) { await Push.enable(); toast('Server push on.'); }
      else { await Push.disable(); toast('Server push off.'); }
    } catch (err) {
      e.target.checked = false;
      toast(err.message, 'bad');
    }
  });

  const lang = $('#langSelect');
  lang.replaceChildren(...LANGUAGES.map((l) =>
    el('option', { value: l.id, selected: l.id === Translate.language },
      l.id === 'off' ? l.english : `${l.label} · ${l.english}`)));
  lang.value = Translate.language;
  lang.addEventListener('change', (e) => {
    Store.set('settings.language', e.target.value);
    if (session.revealed) showTranslation(currentWord());
    toast(e.target.value === 'off' ? 'Translation off.' : `Translating into ${Translate.info().english}.`);
  });

  renderThemes();

  // learning
  const goal = $('#goalRange');
  goal.value = s.dailyGoal;
  $('#goalValue').textContent = s.dailyGoal;
  goal.addEventListener('input', (e) => {
    $('#goalValue').textContent = e.target.value;
    Store.set('settings.dailyGoal', Number(e.target.value));
    renderHeader(Store.state);
  });

  const nw = $('#newRange');
  nw.value = s.newPerDay;
  $('#newValue').textContent = s.newPerDay;
  nw.addEventListener('input', (e) => {
    $('#newValue').textContent = e.target.value;
    Store.set('settings.newPerDay', Number(e.target.value));
    refillQueue();
    renderQueueSummary(Store.state);
  });

  const level = $('#levelSelect');
  level.value = Store.state.profile.level;
  level.addEventListener('change', (e) => Store.set('profile.level', e.target.value));

  // AI — one choice of engine, one status line, server fields only when needed.
  /* The stored value verbatim, including an empty one. Falling back to the
     localhost default here put that address back in the box every time
     Settings was opened, so clearing it — which is what you do when the proxy
     serves the app itself — looked like it had not worked. */
  $('#aiEndpoint').value = s.ai.endpoint ?? AICFG.defaultEndpoint;
  showEndpointHelp();
  const modelSelect = $('#aiModel');

  $('#aiModePicker').replaceChildren(...Object.entries(PROVIDERS).map(([id, p]) =>
    el('button', {
      class: 'seg__btn', type: 'button', role: 'tab', 'data-ai': id,
      onclick: () => {
        Store.set('settings.ai.provider', id);
        // `mode` is what older code and older saves read.
        Store.set('settings.ai.mode', id === 'built-in' ? 'mock' : 'proxy');
        showAIProvider(id);
        refreshAIStatus();
        drawChatMode();
      },
    }, p.label)));

  const showAIProvider = (id) => {
    for (const btn of $$('#aiModePicker .seg__btn')) {
      btn.classList.toggle('is-active', btn.dataset.ai === id);
    }
    $('#aiProviderBlurb').textContent = PROVIDERS[id]?.blurb || '';
    $('#aiProxyFields').hidden = !PROVIDERS[id]?.needsProxy;

    // Each engine has its own models; showing Claude's list under Gemini would
    // only invite a request the proxy has to reject.
    const models = id === 'gemini' ? AICFG.geminiModels : AICFG.models;
    modelSelect.replaceChildren(...models.map((m) => el('option', { value: m.id, text: m.label })));
    const saved = id === 'gemini' ? s.ai.geminiModel : s.ai.model;
    modelSelect.value = models.some((m) => m.id === saved) ? saved : models[0].id;
  };

  /**
   * Offer the one-press fix for the one address that cannot work.
   *
   * A published page pointed at localhost is the mistake everybody makes,
   * because it is the development default and it works perfectly on the
   * machine that set it up. Explaining that in a paragraph is worse than
   * offering the button.
   */
  function showEndpointHelp() {
    const endpoint = Store.state.settings.ai.endpoint || '';
    let host = '';
    try { host = new URL(endpoint).hostname; } catch { host = ''; }
    const pointsAtThisMachine = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(host);
    const pageIsLocal = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(location.hostname);
    $('#aiEndpointClear').hidden = !(pointsAtThisMachine && !pageIsLocal);
  }

  async function refreshAIStatus() {
    const text = $('#aiStatusText');
    const dot = $('#aiStatus');
    text.textContent = 'Checking…';
    dot.dataset.state = 'wait';
    const msg = await AIClient.health();
    text.textContent = msg;
    dot.dataset.state = !AIClient.isLive || /^Connected/.test(msg) ? 'ok' : 'bad';
  }

  $('#aiEndpoint').addEventListener('change', (e) => {
    Store.set('settings.ai.endpoint', e.target.value.trim());
    showEndpointHelp();
    refreshAIStatus();
  });
  $('#aiEndpointClear').addEventListener('click', () => {
    $('#aiEndpoint').value = '';
    Store.set('settings.ai.endpoint', '');
    showEndpointHelp();
    refreshAIStatus();
  });
  modelSelect.addEventListener('change', (e) => {
    Store.set(AIClient.provider === 'gemini' ? 'settings.ai.geminiModel' : 'settings.ai.model',
      e.target.value);
    refreshAIStatus();
  });
  $('#aiTest').addEventListener('click', refreshAIStatus);

  showAIProvider(AIClient.provider);
  refreshAIStatus();

  // data
  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([Store.export()], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `vocabx-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      Store.import(await file.text());
      toast('Backup restored.');
      refillQueue();
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  $('#resetBtn').addEventListener('click', async () => {
    if (!confirm('Delete all progress and restore the starter deck?')) return;
    await Store.reset();          // the starter deck is fetched on demand now
    session.queue = [];
    render();
    toast('Reset to the starter deck.');
  });

  renderRoutine();
}

/**
 * The routine builder: one row per step, each editable in place.
 *
 * Editing time and action inline rather than behind a dialog keeps the whole
 * day visible while you rearrange it, which is the only reason to have a
 * builder rather than a list of times.
 */
function renderRoutine() {
  const routine = sortRoutine(Store.state.settings.reminders.routine || []);
  const list = $('#routineList');

  if (!routine.length) {
    list.replaceChildren(el('p', { class: 'hint', text: 'No steps yet — add one below.' }));
    updateRoutineNote(routine);
    return;
  }

  list.replaceChildren(...routine.map((step) => {
    const meta = ACTIONS[step.action] || ACTIONS.review;

    const time = el('input', {
      class: 'input input--time', type: 'time', value: step.time,
      onchange: (e) => {
        if (!validTime(e.target.value)) { e.target.value = step.time; return; }
        editStep(step.id, { time: e.target.value });
      },
    });

    const action = el('select', { class: 'input input--select', onchange: (e) => editStep(step.id, { action: e.target.value }) },
      ...Object.entries(ACTIONS).map(([id, a]) =>
        el('option', { value: id, text: a.label, ...(id === step.action ? { selected: 'selected' } : {}) })));

    return el('div', { class: 'step' },
      el('div', { class: 'step__row' }, time, action,
        el('button', {
          class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': `Remove the ${step.time} step`,
          onclick: () => {
            Store.commit((st) => {
              st.settings.reminders.routine = st.settings.reminders.routine.filter((x) => x.id !== step.id);
            });
            renderRoutine();
          },
        }, icon('close'))),
      el('p', { class: 'step__hint', text: meta.hint }));
  }));

  updateRoutineNote(routine);
}

/** What a step would say right now — used by the test button. */
function previewCard(step) {
  const state = Store.state;
  const counts = queueCounts(state);
  const words = Object.values(state.words).filter((w) => w.definition);
  return cardFor(step, {
    due: counts.due, learning: counts.learning, fresh: counts.new,
    doneToday: state.days[dayKey()]?.reviews || 0,
    dailyGoal: state.settings.dailyGoal,
    word: words[Math.floor(Math.random() * words.length)] || null,
    quote: quoteFor(dayKey()),
    moduleTitle: session.continueSet?.module?.title || '',
    setNumber: (session.continueSet?.index ?? 0) + 1,
  });
}

function editStep(id, patch) {
  Store.commit((s) => {
    s.settings.reminders.routine = s.settings.reminders.routine.map((step) =>
      (step.id === id ? { ...step, ...patch } : step));
  });
  renderRoutine();
}

/**
 * The honest note under the builder.
 *
 * Local reminders only fire while a tab is open — that is the platform, not a
 * bug, and someone building a 7am routine deserves to know before they rely on
 * it rather than after it silently does not arrive.
 */
function updateRoutineNote(routine) {
  const note = $('#routineNote');
  const cards = routine.filter((s) => ACTIONS[s.action]?.passive).length;
  const parts = [];
  if (cards) {
    parts.push(`${cards} of these ${cards === 1 ? 'is a card' : 'are cards'} you only read — they land on your lock screen.`);
  }
  parts.push(Store.state.settings.push?.enabled
    ? 'Server push is on, so these arrive whether or not the app is open.'
    : 'These fire while VocabX is open in a tab. For them to arrive with the app closed, turn on server push above.');
  note.textContent = parts.join(' ');
}

function refreshNotifyState() {
  const label = $('#notifyState');
  const state = Notifier.permission;
  label.textContent = {
    granted: 'Reminders are on. Times below fire while the app is open in a tab.',
    denied: 'Notifications are blocked for this site — allow them in your browser settings.',
    default: 'Notifications are not enabled yet.',
    unsupported: 'This browser does not support notifications.',
  }[state] || state;
  $('#notifyEnable').disabled = state === 'granted' || state === 'unsupported';
  $('#pushToggle').checked = Boolean(Store.state.settings.push?.enabled);
}

// ── extras ─────────────────────────────────────────────────────────────────
function speak(text) {
  if (!text || !Store.state.settings.speech || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'en-GB';
  utter.rate = 0.95;
  speechSynthesis.speak(utter);
}

/**
 * Keyboard shortcuts, for the two screens where a whole session is one key
 * repeated. Review had them and never said so; Test did not have them at all,
 * which made a forty-question round forty round trips to the mouse.
 */
function wireKeyboard() {
  addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;      // leave browser keys alone
    const digit = ['1', '2', '3', '4'].indexOf(e.key);

    if (!$('#view-learn').hidden) {
      if (e.code === 'Space') { e.preventDefault(); session.revealed ? gradeCard(2) : reveal(); }
      else if (digit >= 0 && session.revealed) gradeCard(digit);
      else if (e.key === 's') speak(currentWord()?.term);
      else if (e.key === 'z') undoGrade();
      return;
    }

    if (!$('#view-test').hidden && lab?.questions?.length) {
      // Once an answer is in, every key that would answer moves on instead.
      if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); checkAnswer(); return; }
      if (digit >= 0 && !lab.checked) {
        const option = $$('#testOptions .option')[digit];
        if (option && !option.disabled) { e.preventDefault(); option.click(); }
      } else if (e.key === 's') speak(lab.questions[lab.at]?.term);
    }
  });
}

// Service worker asks the page to open a view when a notification is clicked.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'navigate' && e.data.view) switchView(e.data.view);
});

boot();
