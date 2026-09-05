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
import { learningBrief, briefText, headline, prompts, localAdvice } from './brief.js';
import { Sync, pushSoon, snapshotOf, mergeSnapshots, hasWork } from './sync.js';
import { declarations, runAction } from './actions.js';
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
import { feedbackAsText, feedbackSubject, feedbackMailto, anonymise,
         manifestOf } from './feedback.js';
import { SUBJECTS, modesFor, buildRound, markOne, markRound } from './testlab.js';
import { createInstaller, downloadFor } from './install.js';
import { Auth, serverAccounts } from './auth.js';
import { openGate, initialOf } from './gate.js';
import { shouldLook, digest, suggestable, validate, localNotice, remember, settle,
         open as openNotice } from './notice.js';

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
  wireAssist();
  wireSync();
  wireAccount();
  wireNotice();
  wireFeedbackView();
  wireInbox();
  wireTest();
  wireAsk();
  wireAssess();
  wireProgress();
  wireSettings();
  wireKeyboard();

  Store.on(() => renderHeader(Store.state));
  render();

  /* The welcome, on a first run only. It goes up before the app is revealed
     so nobody sees the app flash behind it, and the app is fully wired by
     now, so whatever they choose lands on a screen that is already ready. */
  if (!Auth.chose) {
    const { how } = await openGate();
    if (how === 'signup' || how === 'login') await joinAccount(how);
  }
  drawAccount();

  $('#app').hidden = false;

  const startView = location.hash.replace('#', '');
  if (startView === 'inbox') openInbox();
  else if ($$('.tab').some((t) => t.dataset.tab === startView)) switchView(startView);
  else switchView('home');
  // So #inbox works without a reload, typed into the bar of an app already open.
  window.addEventListener('hashchange', () => {
    if (location.hash === '#inbox' && $('#view-inbox').hidden) openInbox();
  });

  /* A kept session is re-checked in the background rather than before the
     first paint: the app is entirely usable while the answer is in flight,
     and blocking on it would put a spinner in front of someone who is
     already signed in. */
  if (Auth.token) {
    Auth.resume().then((out) => {
      drawAccount();
      if (out.out) toast('Signed out — your work is still on this device.');
    });
  }

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

  /* Two moments, both of them after something happened rather than on a
     clock: the app being opened, and a session ending. shouldLook() says no
     to nearly all of them. */
  lookAround();

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
  drawNotice();
  /* Profile reads the same ledger every other screen does, so it redraws with
     them. It used to redraw only when the account changed, which meant a
     streak earned since sign-in was not on it. */
  drawProfile();
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
      // What the report should say they were looking at, since by the time
      // they write it they are looking at the feedback screen instead.
      session.lastView = tab.dataset.tab;
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

  /* A session is a hundred gradings, so this coalesces them into one write a
     minute after the last card rather than a hundred as they happen. Does
     nothing at all unless the learner turned syncing on. */
  pushSoon(Store.state);

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
  drawBadge(state);
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
  /* The one Home button is whichever offer this device can actually take:
     the browser's install prompt, or — where there is none — the steps, which
     are in Settings beside the rest of the install answer. */
  $('#homeInstallGo').addEventListener('click', (e) => {
    if (e.currentTarget.dataset.action === 'how') {
      switchView('settings');
      $('#installTitle').closest('.card')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      runInstall();
    }
  });
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
    // The app sits one level below the site root, where download/ lives.
    download: downloadFor(state.os, { base: '../download/' }),
  });
}

// ── the feedback screen ────────────────────────────────────────────────────

/**
 * The full feedback module.
 *
 * The corner button stays — it is what catches a thought the moment it
 * happens — and opens the quick sheet. This screen is for the longer report,
 * and is where anonymity is decided, because anonymity needs room to be shown
 * rather than promised.
 *
 * Nothing here reaches a third party. There is no form service and no
 * analytics; the note goes to your own proxy, your own mail client, or your
 * own clipboard, and a copy stays on the device so you can see what you said.
 */
const fb = { mood: 'mixed', kind: 'idea' };

function wireFeedbackView() {
  for (const [group, key] of [['#fbMood', 'mood'], ['#fbKind', 'kind']]) {
    for (const btn of $$(`${group} .seg__btn`)) {
      btn.addEventListener('click', () => {
        fb[key] = btn.dataset[key];
        for (const b of $$(`${group} .seg__btn`)) b.classList.toggle('is-active', b === btn);
        drawManifest();
      });
    }
  }
  $('#fbAnon').addEventListener('change', () => {
    $('#fbSigned').hidden = $('#fbAnon').checked;
    drawManifest();
  });
  $('#fbText').addEventListener('input', drawManifest);
  $('#fbFrom').addEventListener('input', drawManifest);
  $('#fbSend').addEventListener('click', () => submitFeedback('send'));
  $('#fbMail').addEventListener('click', () => submitFeedback('mail'));
  $('#fbCopy').addEventListener('click', () => submitFeedback('copy'));
  $('#fbClear').addEventListener('click', () => {
    Store.commit((st) => { st.feedback = []; });
    drawFeedbackHistory();
  });
}

/** The report as it would go out right now, anonymised if that is asked for. */
function viewReport() {
  const full = {
    kind: fb.kind,
    mood: fb.mood,
    text: $('#fbText').value.trim(),
    from: $('#fbAnon').checked ? '' : $('#fbFrom').value.trim(),
    at: new Date().toISOString(),
    context: {
      view: session.lastView || 'feedback',
      provider: AIClient.provider,
      level: Store.state.profile.level,
      words: Object.keys(Store.state.words).length,
      screen: `${window.innerWidth}x${window.innerHeight}`,
    },
  };
  return $('#fbAnon').checked ? anonymise(full) : full;
}

/** The list under the form, rebuilt from the payload that would actually go. */
function drawManifest() {
  const rows = manifestOf(viewReport());
  $('#fbManifest').replaceChildren(...rows.map((r) => el('li', {
    class: r.sent ? 'manifest__row' : 'manifest__row is-off',
  },
    el('span', { class: 'manifest__mark', 'aria-hidden': 'true' }, r.sent ? '✓' : '—'),
    el('span', { class: 'manifest__label', text: r.label }),
    el('span', { class: 'manifest__value', text: r.value }))));

  $('#fbNote').textContent = AIClient.isLive
    ? 'Send goes to your own server. Nothing passes through anyone else.'
    : `No server is connected, so Send only keeps it here. Use “Email it instead” to reach ${APP.feedbackTo}.`;
}

async function submitFeedback(how) {
  const report = viewReport();
  if (!report.text) { toast('Write something first.', 'bad'); return; }

  // Kept on the device either way, so the reader can see what they reported.
  Store.commit((st) => { (st.feedback ||= []).push(report); st.feedback = st.feedback.slice(-50); });

  if (how === 'mail') {
    location.href = feedbackMailto(report, APP.feedbackTo);
    finishFeedback('Opening your mail app…');
    return;
  }
  if (how === 'copy') {
    await navigator.clipboard.writeText(feedbackAsText(report)).catch(() => {});
    finishFeedback('Copied. Paste it wherever suits you.');
    return;
  }
  if (!AIClient.isLive) { finishFeedback('Kept on this device — no server is connected.'); return; }

  const btn = $('#fbSend');
  btn.disabled = true;
  try {
    const res = await fetch(AIClient.url('/api/feedback'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || `server responded ${res.status}`);
    finishFeedback('Thank you — sent.');
  } catch (err) {
    // It is on the device regardless, so say that rather than "failed".
    toast(`Kept here — ${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
}

function finishFeedback(message) {
  $('#fbText').value = '';
  $('#fbFrom').value = '';
  drawManifest();
  drawFeedbackHistory();
  toast(message);
}

const FB_KIND = { idea: 'Idea', bug: 'Something broke', word: 'A word is wrong' };

function drawFeedbackHistory() {
  const sent = [...(Store.state.feedback || [])].reverse();
  $('#fbHistoryCard').hidden = sent.length === 0;
  $('#fbHistory').replaceChildren(...sent.map((r) => el('div', { class: 'fb-log__row' },
    el('div', { class: 'fb-log__head' },
      el('span', { class: 'fb-log__kind', text: FB_KIND[r.kind] || r.kind }),
      el('span', { class: 'fb-log__when',
        text: new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }),
      r.anonymous ? el('span', { class: 'tag', text: 'anonymous' }) : null),
    el('p', { class: 'fb-log__text', text: r.text }))));
}

function openFeedbackView() {
  /* Read the screen off the page before leaving it. A tab click records this
     too, but the corner button can be pressed from anywhere — including from
     a view with no tab of its own — and "you were on the feedback screen" is
     the one useless answer. */
  const here = [...$$('.view')].find((v) => !v.hidden)?.dataset.view;
  if (here && here !== 'feedback') session.lastView = here;
  switchView('feedback');
  drawManifest();
  drawFeedbackHistory();
  $('#fbText').focus();
}

// ── the inbox ──────────────────────────────────────────────────────────────

/**
 * Where feedback ends up, for whoever runs the app.
 *
 * A note stored on the proxy is no use if reading it means a curl command, so
 * this is the reader. There is no link to it anywhere — it is reached by
 * putting #inbox in the address bar — because it is not a feature of the app,
 * and a visitor who finds it sees a token box and nothing behind it.
 *
 * The token is kept in this browser rather than in the deck, so it is not
 * carried into an export someone might share, and it never becomes part of
 * the state a reader's own device holds.
 */
const INBOX_TOKEN_KEY = 'vocabx.inbox.token';

function wireInbox() {
  $('#inboxLoad').addEventListener('click', loadInbox);
  $('#inboxForget').addEventListener('click', () => {
    try { localStorage.removeItem(INBOX_TOKEN_KEY); } catch { /* private mode */ }
    $('#inboxToken').value = '';
    $('#inboxList').replaceChildren();
    $('#inboxNote').textContent = 'Token forgotten on this device.';
  });
}

function openInbox() {
  switchView('inbox');
  try { $('#inboxToken').value = localStorage.getItem(INBOX_TOKEN_KEY) || ''; } catch { /* ignore */ }
  $('#inboxNote').textContent = '';
  if ($('#inboxToken').value) loadInbox();
}

async function loadInbox() {
  const token = $('#inboxToken').value.trim();
  if (!token) { $('#inboxNote').textContent = 'Paste the token first.'; return; }

  const btn = $('#inboxLoad');
  btn.disabled = true;
  $('#inboxNote').textContent = 'Reading…';
  try {
    const res = await fetch(AIClient.url('/api/feedback/list'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || `server responded ${res.status}`);

    try { localStorage.setItem(INBOX_TOKEN_KEY, token); } catch { /* private mode */ }
    drawInbox(body.data || []);
  } catch (err) {
    $('#inboxList').replaceChildren();
    $('#inboxNote').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function drawInbox(notes) {
  const anon = notes.filter((n) => n.anonymous).length;
  $('#inboxNote').textContent = notes.length
    ? `${notes.length} note${notes.length === 1 ? '' : 's'}, ${anon} anonymous. Newest first.`
    : 'Nothing yet.';
  $('#inboxSub').textContent = notes.length
    ? 'What people have sent you.'
    : 'Nothing has come in yet.';

  $('#inboxList').replaceChildren(...notes.map((n) => {
    const when = new Date(n.at);
    const c = n.context || {};
    /* Only what the sender chose to attach. An anonymous note has no context
       at all, and this must not invent one from the absence. */
    const where = [c.view, c.provider, c.level && `level ${c.level}`,
                   c.words != null && `${c.words} words`, c.screen].filter(Boolean).join(' · ');
    return el('div', { class: 'fb-log__row' },
      el('div', { class: 'fb-log__head' },
        el('span', { class: 'fb-log__kind', text: FB_KIND[n.kind] || n.kind }),
        n.mood ? el('span', { class: 'tag', text: n.mood }) : null,
        el('span', { class: 'fb-log__when',
          text: when.toLocaleString(undefined, { month: 'short', day: 'numeric',
                                                 hour: '2-digit', minute: '2-digit' }) }),
        n.anonymous ? el('span', { class: 'tag', text: 'anonymous' }) : null),
      el('p', { class: 'fb-log__text', text: n.text }),
      n.from ? el('p', { class: 'hint' }, el('a', { href: `mailto:${n.from}`, text: n.from })) : null,
      where ? el('p', { class: 'hint', text: where }) : null);
  }));
}

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

/* ── assistance ─────────────────────────────────────────────────────────── */

/**
 * The assistant, in the corner, on every screen.
 *
 * It is the same engine as the Ask tab, asked a different way. Ask is where
 * you bring a question about a word; this is where you bring a question about
 * *yourself* — what to do now, why a word keeps slipping, whether the week has
 * gone well. Those questions are unanswerable without the numbers, so every
 * message carries a derived snapshot of them.
 *
 * What is sent is counts, rates and a handful of terms. Never the history log,
 * never anything typed into feedback, never a word list — a snapshot that fits
 * in a few hundred characters cannot leak what it does not contain.
 */
/* ── keeping the work somewhere else ────────────────────────────────────── */

/* ── the assistant, unprompted ──────────────────────────────────────────── */

/**
 * Ask whether anything is worth saying, and if so, say it.
 *
 * Runs after a session ends and when the app is opened, never during one.
 * `shouldLook` says no nearly always — the cost of asking is one cheap read of
 * the ledger, and the cost of getting this wrong is an assistant nobody wants
 * on. Failure is silent by design: this is not a request anyone is waiting on,
 * so a dead network is the same as nothing worth remarking.
 */
let looking = false;
async function lookAround() {
  if (looking) return;
  const view = $$('.view').find((v) => !v.hidden)?.dataset.view || '';
  if (!shouldLook(Store.state, { view })) return;

  looking = true;
  try {
    const due = readyNow(plannedSession(Store.state));
    const saw = digest(Store.state, { due });

    /* The engine gets the digest and the names of the settings it may propose
       — never the ability to change one. What comes back is a note, and a
       note is words plus at most the name of an action. */
    const raw = AIClient.isLive
      ? await AIClient.notice({ digest: saw, actions: suggestable(),
                                level: Store.state.profile.level })
      : null;

    const note = raw
      ? validate(raw, { engine: AIClient.engine, model: AIClient.model, saw })
      : localNotice(Store.state, { due });

    remember(note);
    render();
  } finally {
    looking = false;
  }
}

/** What the switch in Settings says about itself right now. */
function drawNoticeSetting() {
  const on = Boolean(Store.state.settings.notices?.enabled);
  $('#noticeToggle').checked = on;
  $('#noticeNote').textContent = !on
    ? 'Off. Nothing will appear on Home.'
    : AIClient.isLive
      ? `${AIClient.engine} sees a summary of your counts — never your word list, your `
        + 'answers, or anything you have typed. At most two notes a day.'
      : 'No engine is set, so the notes are the app\u2019s own reading of your numbers, '
        + 'written on this device. At most two a day.';
}

/** What the Accept button on a suggestion says, in the app's own words. */
function acceptLabel(note) {
  // The argument names are the catalogue's, not this function's — a label
  // built from a name the action does not take reads perfectly and passes
  // undefined when pressed, which is exactly what it did.
  if (note.action === 'set_daily_goal') return `Set the goal to ${note.args.reviews}`;
  if (note.action === 'set_new_per_day') return `Make it ${note.args.words} new a day`;
  if (note.action === 'set_reminders_enabled') return note.args.on ? 'Turn reminders on' : 'Turn reminders off';
  if (note.action === 'set_reminder') return `Add a reminder at ${note.args.time}`;
  return 'Do it';
}

function drawNotice() {
  const note = openNotice(Store.state);
  const card = $('#noticeCard');
  card.hidden = !note;
  if (!note) return;

  $('#noticeText').textContent = note.text;

  /* The signature, and the reason this feature is allowed to speak first. It
     names the engine, the model and the time, and says outright that a
     machine wrote it — the app never lets one engine's words be labelled as
     another's, and unprompted words need that more, not less. */
  const when = new Date(note.at).toLocaleString(undefined,
    { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' });
  $('#noticeBy').textContent = `Written by ${note.engine}${note.model ? ` · ${note.model}` : ''} · ${when}`;

  /* Once a suggestion has been accepted the card stops offering it and starts
     offering the way back. It is the learner who closes the note, not the act
     of agreeing to it — otherwise "Undo" would flash past with the card. */
  const done = note.state === 'done';
  const suggestion = !done && note.kind === 'suggestion' && note.action;
  $('#noticeSuggest').hidden = !suggestion;
  $('#noticeAsk').hidden = done || note.kind !== 'question';
  $('#noticePlain').hidden = suggestion || (!done && note.kind === 'question');
  if (suggestion) $('#noticeAccept').textContent = acceptLabel(note);

  if (done) {
    $('#noticeText').textContent = note.result || note.text;
    // The closure that undoes it lives on this page only. After a reload
    // there is nothing to offer, so nothing is offered.
    $('#noticeUndo').hidden = !(undoable && undoable.id === note.id);
    $('#noticeOk').textContent = 'Close';
  } else {
    $('#noticeUndo').hidden = true;
    $('#noticeOk').textContent = 'Got it';
  }
}

/* The way back out of an accepted suggestion. A closure, so it lives on this
   page only — which is why the button is drawn from it rather than from the
   note, and why a reload offers nothing it cannot deliver. */
let undoable = null;

function wireNotice() {
  $('#noticeOk').addEventListener('click', () => {
    const note = openNotice(Store.state);
    settle(note?.id, note?.state === 'done' ? 'accepted' : 'dismissed');
    undoable = null;
    render();
  });

  $('#noticeDecline').addEventListener('click', () => {
    settle(openNotice(Store.state)?.id, 'declined');
    render();
    toast('Left as it was.');
  });

  /* The only path from a suggestion to a change, and it runs through the same
     runAction and the same Undo as everything the assistant does when asked.
     Nothing about a note being unprompted earns it a shortcut. */
  $('#noticeAccept').addEventListener('click', async () => {
    const note = openNotice(Store.state);
    if (!note?.action) return;

    const result = await runAction(note.action, note.args, await actionContext());
    if (result?.refused) {
      /* The action refused what the note offered — a range it would not take,
         or a state that has moved since. The note becomes the refusal rather
         than a button that does nothing. */
      settle(note.id, 'done', { result: `Not done: ${result.refused}` });
      undoable = null;
      render();
      return;
    }

    undoable = result.undo ? { id: note.id, undo: result.undo } : null;
    settle(note.id, 'done', { result: result.say || 'Done.' });
    render();
    toast(result.say || 'Done.');
  });

  $('#noticeUndo').addEventListener('click', () => {
    if (!undoable) return;
    undoable.undo();
    settle(undoable.id, 'declined');
    undoable = null;
    render();
    toast('Put back.');
  });

  $('#noticeAsk').addEventListener('submit', (e) => {
    e.preventDefault();
    const answer = $('#noticeAnswer').value.trim().slice(0, 200);
    /* Kept on the note and shown to the engine next time, so an answer is a
       reply rather than a form submission into nothing. */
    settle(openNotice(Store.state)?.id, 'answered', { answer });
    $('#noticeAnswer').value = '';
    render();
    toast(answer ? 'Noted.' : 'Skipped.');
  });

  const toggle = $('#noticeToggle');
  toggle.checked = Boolean(Store.state.settings.notices?.enabled);
  toggle.addEventListener('change', () => {
    Store.set('settings.notices.enabled', toggle.checked);
    drawNoticeSetting();
    toast(toggle.checked ? 'It will speak up when it has something.' : 'It will stay quiet.');
    if (toggle.checked) lookAround();
  });
  drawNoticeSetting();

  $('#noticeOff').addEventListener('click', () => {
    Store.set('settings.notices.enabled', false);
    settle(openNotice(Store.state)?.id, 'dismissed');
    render();
    $('#noticeToggle').checked = false;
    toast('It will not speak up again. Settings can turn it back on.');
  });
}

/**
 * What happens the moment someone stops being a guest.
 *
 * Signing up is easy — the account is new, so this device's work is simply
 * pushed up. Signing in is the one that can destroy a fortnight of study: the
 * account has a snapshot and this device has its own, and choosing either one
 * loses the other. So they are merged, and only then written back. sync.js
 * sets out the rule for every field.
 */
async function joinAccount(how) {
  if (!Auth.isIn) return;

  try {
    if (how === 'signup') {
      const at = await Sync.push(Store.state);
      if (at) Store.set('settings.sync.lastAt', at);
      toast(`Account made. Your work is saved as ${Auth.user?.name || Auth.user?.email}.`);
      return;
    }

    const found = await Sync.pull();
    if (!found?.snapshot) {
      // Nothing up there yet — this device becomes the record.
      const at = await Sync.push(Store.state);
      if (at) Store.set('settings.sync.lastAt', at);
      toast(`Signed in as ${Auth.user?.name || Auth.user?.email}.`);
      return;
    }

    /* Read before anything is applied. Afterwards the answer is always yes —
       the merged state is in the store by then — and the message would tell
       someone their fresh phone had been merged with something. */
    const hadWork = hasWork(Store.state);

    const merged = hadWork
      ? mergeSnapshots(snapshotOf(Store.state), found.snapshot)
      : found.snapshot;
    applySnapshot(merged);

    // Written straight back, so the other device sees the join too rather
    // than pushing its own half over it on its next sync.
    const at = await Sync.push(Store.state);
    if (at) Store.set('settings.sync.lastAt', at);

    toast(hadWork
      ? 'Signed in. Your saved work and this device\'s have been merged.'
      : 'Signed in. Your saved work is back.');
  } catch {
    /* The account is real and the session is good; only the first sync
       failed. Saying nothing would look like the work was lost. */
    toast('Signed in, but could not reach your saved work yet. It will sync later.', 'bad');
  }
}

/**
 * The one thing in the header that has two possible truths.
 *
 * Signed in it is the account's initial; a guest has no face to show, so it
 * stays the level badge it has always been. Both callers go through here
 * rather than writing to the element: they used to, and the later of the two
 * won — which meant signing up showed a level for as long as it took the
 * module manifest to land, and then still did.
 */
function drawBadge(state = Store.state) {
  const badge = $('#levelBadge');
  const user = Auth.isIn ? Auth.user : null;

  badge.textContent = user ? initialOf(user) : standing(state.xp?.total || 0).level;
  badge.title = user ? `Signed in as ${user.name || user.email}` : 'Your level';
  badge.classList.toggle('avatar--who', Boolean(user));
}

/**
 * The name to put on screen.
 *
 * An account's name wins, because it is the one that followed you here. A
 * guest's is theirs alone and lives on the device — which is the only place a
 * guest has, and is not a lesser answer.
 */
function myName() {
  return (Auth.isIn ? Auth.user?.name : Store.state.profile?.name) || '';
}

/**
 * The Profile screen.
 *
 * The same screen for a guest and for someone signed in — the standing, the
 * streak and the ledger are the learner's, not the account's, and hiding them
 * behind a signup would be a lie about where the work lives. What the account
 * adds is an email line and somewhere to sign out.
 */
function drawProfile() {
  const state = Store.state;
  const user = Auth.isIn ? Auth.user : null;
  const name = myName();
  const s = summary(state);
  const rank = standing(state.xp?.total || 0);

  $('#profFace').textContent = (name || '?').trim()[0]?.toUpperCase() || '?';
  $('#profName').textContent = name || 'Learner';
  $('#profTitle').textContent = `Level ${rank.level} · ${rank.title}`;
  $('#profWhere').textContent = user
    ? `${user.email} · member since ${monthOf(user.made)}`
    : `Guest · on this device since ${monthOf(state.createdAt)}`;

  /* An account's name is on the server, a guest's is on the device, and the
     hint says which so nobody is surprised by where it did or did not follow
     them. */
  $('#profNameHint').textContent = user
    ? 'What the app calls you, saved to your account and shown on every device you sign in on.'
    : 'What the app calls you. Kept on this device — an account would carry it with you.';
  // Not clobbered mid-edit: this redraws on every store change.
  if (document.activeElement !== $('#profNameInput')) $('#profNameInput').value = name;

  $('#profLevelNote').textContent = rank.need
    ? `${rank.into} of ${rank.need} XP towards level ${rank.level + 1}.`
    : `Level ${rank.level}.`;
  $('#profLevelFill').style.width = `${Math.round(rank.pct * 100)}%`;

  const minutes = Math.round(
    Object.values(state.days || {}).reduce((n, d) => n + (d.seconds || 0), 0) / 60);
  $('#profStats').replaceChildren(...[
    ['Words learned', s.studied],
    ['Now in review', s.known],
    ['Day streak', s.streak],
    ['Longest streak', s.longest],
    ['Days active', activeDays(state)],
    ['Time studied', minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes} min`],
  ].map(([label, value]) => el('div', { class: 'profile__stat' },
    el('b', { text: String(value) }), el('span', { text: label }))));

  /* Only once they have sat it. An empty "your level: —" on a first run is a
     reproach rather than information; Home already invites them to take it. */
  const exam = state.placement;
  $('#profExam').hidden = !exam;
  if (exam) {
    const when = new Date(exam.at || Date.now()).toLocaleDateString(
      undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    $('#profExamNote').textContent = `${exam.level} — ${exam.correct} of ${exam.answered} `
      + `right, taken ${when}.`;
  }
}

/** "March 2026", or nothing at all rather than "Invalid Date". */
function monthOf(when) {
  const at = when ? new Date(when) : null;
  if (!at || Number.isNaN(at.getTime())) return 'today';
  return at.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** The Profile screen, and the initial in the header. */
function drawAccount() {
  const user = Auth.isIn ? Auth.user : null;

  $('#acctIn').hidden = !user;
  $('#acctOut').hidden = Boolean(user);
  $('#acctStatus').dataset.state = user ? 'ok' : 'wait';
  $('#acctHow').textContent = user
    ? 'Signed in. Your work is saved as you study, on every device you sign in on.'
    : 'Not signed in. Everything is on this device — which is fine, and is how '
      + 'most people use it. An account is for surviving a cleared browser.';

  $('#settingsAcctHint').textContent = user
    ? `Signed in as ${user.email}. Your name, your standing and signing out are on Profile.`
    : 'Not signed in. Your name and your standing are on Profile, along with signing up.';

  /* Also called from render(). Signing out does not go through render(), and a
     profile still showing the account someone just left is worse than one
     extra pass over six tiles. */
  drawProfile();
  drawBadge();
  /* The sync card's answer depends on this one — signing in turns it on — so
     it is redrawn from here rather than at each of the five places that
     change an account. It was not, and signing up left "Off. Everything stays
     on this device." on screen underneath a card saying the opposite. */
  drawSync();

  /* Asked after the card is drawn, never before: the card must not wait on
     the network to appear. If this deployment has no database the two buttons
     go quiet here rather than opening a form that cannot finish. */
  if (!user) {
    serverAccounts().then((can) => {
      $('#acctSignup').disabled = !can;
      $('#acctSignin').disabled = !can;
      if (!can) {
        // "The section below" moved to Settings when this card did.
        $('#acctHow').textContent = 'Accounts are not set up on this deployment, so everything '
          + 'is kept on this device. Nothing else is missing — Settings can still put your '
          + 'work on another device with a code.';
      }
    });
  }
}

function wireAccount() {
  /* The header avatar is the thing on screen that most looks like "you", so
     it is now the way in — it was decoration before. */
  $('#levelBadge').addEventListener('click', () => switchView('profile'));
  $('#settingsProfile').addEventListener('click', () => switchView('profile'));

  // openAssess switches the view itself and draws the last result, so this is
  // the whole of it — Home and Progress reach the same screen the same way.
  $('#profExamGo').addEventListener('click', openAssess);

  const saveName = async () => {
    const name = $('#profNameInput').value.trim().slice(0, 40);

    /* A guest's name goes in the store and nowhere else; an account's has to
       reach the server or it would come back wrong on the next device. The
       local copy is written either way, so the screen never argues with the
       box someone just typed in. */
    Store.set('profile.name', name);
    if (!Auth.isIn) { drawAccount(); toast(name ? `Hello, ${name}.` : 'Name cleared.'); return; }

    const out = await Auth.rename(name);
    drawAccount();
    toast(out?.ok ? 'Name saved to your account.' : (out?.error || 'Could not reach the server.'),
      out?.ok ? 'ok' : 'bad');
  };

  $('#profNameSave').addEventListener('click', saveName);
  $('#profNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveName(); }
  });

  const open = async (mode) => {
    const { how } = await openGate({ mode, dismissible: true });
    if (how === 'signup' || how === 'login') await joinAccount(how);
    drawAccount();
  };

  /* Signing up hands the account the name a guest was already using, rather
     than making them type it a second time into a form that already asked. */
  $('#acctSignup').addEventListener('click', () => {
    const mine = Store.state.profile?.name;
    if (mine) setTimeout(() => { const box = $('#gateName'); if (box && !box.value) box.value = mine; }, 0);
  });

  $('#acctSignup').addEventListener('click', () => open('signup'));
  $('#acctSignin').addEventListener('click', () => open('signin'));

  $('#acctSignout').addEventListener('click', async () => {
    await Auth.logout();
    drawAccount();
    toast('Signed out. Your work is still on this device.');
  });

  $('#acctSignoutAll').addEventListener('click', async () => {
    if (!confirm('Sign out on every device you have used?\n\n'
      + 'Your work stays saved — you just have to sign in again.')) return;
    await Auth.logout({ everywhere: true });
    drawAccount();
    toast('Signed out everywhere.');
  });

  $('#acctErase').addEventListener('click', async () => {
    const who = Auth.user?.email || 'this account';
    if (!confirm(`Delete ${who} and everything saved with it?\n\n`
      + 'Your progress and your Ask history go with it. What is on this device '
      + 'stays, and the app keeps working as a guest. This cannot be undone.')) return;
    const out = await Auth.erase();
    drawAccount();
    toast(out?.ok ? 'Account deleted.' : (out?.error || 'Could not reach the server.'),
      out?.ok ? 'ok' : 'bad');
  });
}

/**
 * The optional server copy.
 *
 * Off unless someone turns it on, and every path through it degrades to doing
 * nothing rather than to an error — the app has always worked with only this
 * device, and turning this on must not make that less true.
 */
function wireSync() {
  const toggle = $('#syncToggle');
  toggle.checked = Boolean(Store.state.settings.sync?.enabled);
  $('#syncCode').value = Sync.deviceId() || 'unavailable in this browser';

  toggle.addEventListener('change', async () => {
    Store.set('settings.sync.enabled', toggle.checked);
    drawSync('Saving…');
    if (!toggle.checked) { drawSync(); return; }

    /* Turning it on for the first time on a second device should find the
       work already there rather than overwrite it with an empty start. */
    const found = await Sync.pull();
    if (found && (found.snapshot?.words) && !Object.keys(Store.state.words).length) {
      applySnapshot(found.snapshot);
      toast('Found your saved work and restored it.');
    } else {
      const at = await Sync.push(Store.state);
      if (at) Store.set('settings.sync.lastAt', at);
    }
    drawSync();
  });

  $('#syncCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(Sync.deviceId() || '');
      toast('Code copied.');
    } catch { $('#syncCode').select(); toast('Press Ctrl+C to copy.', 'bad'); }
  });

  $('#syncJoinGo').addEventListener('click', async () => {
    const code = $('#syncJoin').value.trim();
    if (!Sync.adoptId(code)) { toast('That does not look like a code.', 'bad'); return; }
    $('#syncCode').value = Sync.deviceId();
    $('#syncJoin').value = '';
    drawSync('Looking…');

    const found = await Sync.pull();
    if (!found) { drawSync('Nothing is stored under that code yet.'); return; }
    applySnapshot(found.snapshot);
    toast('Joined. Your work from the other device is here.');
    drawSync();
  });

  $('#syncForget').addEventListener('click', async () => {
    if (!confirm('Delete everything stored on the server for this code?\n\n'
      + 'What is on this device stays. This cannot be undone.')) return;
    // Once, not twice: awaiting it inside both arms of the ternary sent the
    // delete a second time.
    const gone = await Sync.forget();
    toast(gone ? 'Deleted from the server.' : 'Could not reach the server.',
      gone ? 'ok' : 'bad');
    drawSync();
  });

  drawSync();
}

/**
 * What the assistant just did, and how to put it back.
 *
 * Shown even when the reply already mentions it. A model saying "I've moved
 * your reminder" is a claim; this is the app's own account of what changed,
 * and it carries the undo, so agreeing after the fact is a real option rather
 * than a form of words.
 */
function showChanges(changes = []) {
  const box = $('#assistChanges');
  box.replaceChildren(...changes.map((c) => {
    const row = el('div', { class: 'assist__change' },
      el('span', { text: c.refused ? `Not done: ${c.refused}` : c.say }));
    if (c.undo) {
      row.append(el('button', {
        class: 'btn btn--quiet btn--sm', type: 'button', text: c.undoLabel || 'Undo',
        onclick: (e) => {
          c.undo();
          e.currentTarget.remove();
          row.append(el('span', { class: 'hint', text: ' — put back.' }));
          toast('Put back.');
        },
      }));
    }
    return row;
  }));
  box.hidden = !changes.length;
}

function drawSync(message) {
  const last = Store.state.settings.sync?.lastAt;

  /* Signing in already answered this question — keeping the work is the whole
     reason anyone makes an account. So the card stops offering a toggle that
     could only ever contradict it, and the device-code section goes with it:
     a code is how a guest reaches a second device, and an account is how
     everyone else does. */
  if (Auth.isIn) {
    $('#syncToggle').checked = true;
    $('#syncToggle').disabled = true;
    $('#syncOwn').hidden = true;
    // "Off by default" is true of the app and false of this screen right now.
    $('#syncIntro').textContent = 'On, because you are signed in — this is what an account '
      + 'is for. Signing out stops it and leaves everything on this device.';
    $('#syncStatus').dataset.state = message ? 'wait' : 'ok';
    $('#syncHow').textContent = message || (last
      ? `Saved to your account. Last sent ${new Date(last).toLocaleString()}.`
      : 'Saved to your account as you study.');
    return;
  }

  const on = Boolean(Store.state.settings.sync?.enabled);
  $('#syncToggle').disabled = false;
  $('#syncOwn').hidden = false;
  $('#syncIntro').textContent = 'Off by default. Everything already works on this device '
    + 'alone — this is for surviving a cleared browser, and picking up where you left off '
    + 'on another phone or laptop.';
  $('#syncStatus').dataset.state = message ? 'wait' : on ? 'ok' : 'wait';
  $('#syncHow').textContent = message || (on
    ? (last ? `Saved. Last sent ${new Date(last).toLocaleString()}.`
            : 'On. Your work is sent as you study.')
    : 'Off. Everything stays on this device.');
}

/**
 * Put a downloaded snapshot back into the app.
 *
 * Replaces the schedule and the ledger, and leaves settings alone: a phone and
 * a laptop want different reminder times, and syncing those would be a bug
 * wearing a feature's clothes.
 */
function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  for (const key of ['words', 'srs', 'days', 'streak', 'xp', 'history']) {
    if (snapshot[key] !== undefined) Store.set(key, snapshot[key]);
  }
  render();
}

function wireAssist() {
  $('#assistBtn').addEventListener('click', openAssist);
  $('#assistClose').addEventListener('click', closeAssist);
  $('#assistSheet').addEventListener('click', (e) => {
    if (e.target.id === 'assistSheet') closeAssist();
  });
  $('#assistSend').addEventListener('click', () => askAssist($('#assistInput').value));
  $('#assistInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') askAssist($('#assistInput').value);
  });
}

function openAssist() {
  const brief = learningBrief(Store.state);
  const due = readyNow(plannedSession(Store.state));

  // On screen before any request leaves the device: the panel already knows
  // this, and making someone wait to be told it would be theatre.
  $('#assistHeadline').textContent = headline(brief, due);
  $('#assistFacts').textContent = briefText(brief);
  $('#assistEngine').textContent = AIClient.engine;
  $('#assistEngine').title = AIClient.engineDetail;
  $('#assistReply').hidden = true;
  $('#assistReply').textContent = '';
  $('#assistChanges').hidden = true;
  $('#assistChanges').replaceChildren();
  $('#assistNote').textContent = AIClient.isLive
    ? `${AIClient.engine} sees the summary above — nothing else leaves this device.`
    : 'Answered on this device. No engine is reachable, so the advice is the app\u2019s own.';

  $('#assistPrompts').replaceChildren(...prompts(brief, due).map((p) =>
    el('button', { class: 'btn btn--quiet btn--sm', type: 'button', text: p.label,
                   onclick: () => askAssist(p.ask) })));

  $('#assistSheet').hidden = false;
  $('#assistInput').focus();
}

function closeAssist() {
  $('#assistSheet').hidden = true;
  $('#assistBtn').focus();
}

let assisting = false;

/**
 * What the assistant is told about its own job.
 *
 * Written as constraints rather than encouragement. A model given actions and
 * no boundary will use them to be helpful in ways nobody asked for — moving a
 * reminder because the conversation drifted near it, sending a notification to
 * be friendly. The rule that matters is the last one.
 */
const ASSIST_SYSTEM = [
  'You are the study assistant inside VocabX, an English vocabulary app.',
  'You can read the learner\u2019s progress and change their settings by calling the',
  'functions you have been given. Look before you act: call get_progress or',
  'get_reminders first when the answer depends on where they actually are.',
  'Change something only when the learner has asked for that change in this',
  'conversation. Never send a notification unless they asked to be reminded or',
  'pushed. If you are unsure whether they want a change, say what you would do',
  'and let them ask. Be brief; two or three sentences is usually enough.',
].join(' ');

/**
 * How the actions reach the learner's own state, and nothing else.
 *
 * Async because the module list is: handing an action a pending Promise where
 * it expects an array turns into a refusal the learner cannot act on.
 */
async function actionContext() {
  const modules = await Catalog.modules().catch(() => []);
  return {
    state: Store.state,
    modules: Array.isArray(modules) ? modules : Object.values(modules || {}),
    commit: (path, value) => { Store.set(path, value); render(); },
    /* Notifications go through the same Notifier the reminders use, so the
       Android bridge and the browser path are both already handled. */
    notify: async (title, body) => {
      if (Notifier.permission !== 'granted') return false;
      return Notifier.show(title, body, { actions: false });
    },
  };
}

/**
 * One exchange: ask, run whatever comes back, ask again with the results.
 *
 * Two rounds and no more. A loop that lets a model call functions until it is
 * satisfied is a loop that can spend somebody's afternoon and somebody's
 * credit, and nothing in this catalogue needs a third.
 */
async function assistTurn(question, onText) {
  const tools = declarations();
  let out = await AIClient.act({ question, system: ASSIST_SYSTEM, tools });
  if (out.offline) return { text: '', offline: true, changes: [] };

  const changes = [];
  if (out.calls?.length) {
    const ctx = await actionContext();
    const results = [];
    // At most four in a turn: enough to read then write, short of a runaway.
    for (const call of out.calls.slice(0, 4)) {
      const result = await runAction(call.name, call.args, ctx);
      results.push({
        // Claude matches a result to its call by id; Gemini matches by name.
        // Carrying both means neither engine needs a special case here.
        id: call.id,
        name: call.name,
        result: result.data || result.say || result.refused,
        failed: Boolean(result.refused),
      });
      if (result.say || result.refused) changes.push({ ...result, name: call.name });
    }
    onText?.('');
    /* The history shape is the engine's own — Gemini wants `parts`, Claude
       wants `content` — so the question is echoed back in whichever one the
       first call returned, and the turn is passed through untouched. */
    const asked = AIClient.provider === 'gemini'
      ? { role: 'user', parts: [{ text: question }] }
      : { role: 'user', content: question };
    out = await AIClient.act({
      system: ASSIST_SYSTEM, tools, results,
      history: out.turn ? [asked, out.turn] : [],
    });
  }
  return { text: out.text || '', changes };
}

async function askAssist(question) {
  const q = (question || '').trim();
  if (!q || assisting) return;
  assisting = true;
  $('#assistInput').value = '';
  $('#assistSend').disabled = true;

  const reply = $('#assistReply');
  reply.hidden = false;
  reply.textContent = '';

  /* The snapshot rides with the question rather than being a separate call,
     so the engine cannot answer about a state it was never shown. */
  const brief = learningBrief(Store.state);
  const framed = `Here is where I am with my vocabulary learning. ${briefText(brief)}\n\n${q}`;

  const due = readyNow(plannedSession(Store.state));

  /* AIClient.ask falls back to its own offline tutor rather than throwing, and
     that tutor knows about words, not about you — it answers "how am I doing"
     with "that needs a live engine". So the no-engine case is decided here,
     before the call, and answered from the snapshot the app already holds. */
  if (!AIClient.isLive) {
    reply.textContent = localAdvice(brief, due);
    assisting = false;
    $('#assistSend').disabled = false;
    return;
  }

  try {
    /* Both live engines can act, not only answer: they read the progress and
       change the settings the learner asked them to change. The built-in
       tutor cannot, and falls through to the streaming answer below. */
    if (AIClient.isLive) {
      const out = await assistTurn(framed);
      reply.textContent = out.text || 'Done.';
      showChanges(out.changes);
      Sync.saveChat(q, reply.textContent, AIClient.engine);
      return;
    }

    await AIClient.ask({ question: framed, level: Store.state.settings.level },
      (token) => { reply.textContent += token; reply.scrollTop = reply.scrollHeight; });
  } catch (err) {
    /* Never a dead panel. The generic offline tutor knows about words, not
       about you, so a question about progress is answered from the snapshot
       the app already holds rather than with "that needs a live engine". */
    reply.textContent = localAdvice(brief, due);
    $('#assistNote').textContent = `${AIClient.engine} was unreachable (${err.message}).`;
    // Worth keeping: this is the half of the history that is not reproducible
    // from the schedule. Fire and forget — a failed save must not surface as
    // an error over an answer that arrived fine.
    Sync.saveChat(q, reply.textContent, AIClient.engine);
  } finally {
    assisting = false;
    $('#assistSend').disabled = false;
  }
}

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
  // Carry whatever has been typed through, so the sheet is a draft of the
  // longer form rather than work to be redone.
  $('#feedbackMore').addEventListener('click', () => {
    const draft = $('#feedbackText').value;
    closeFeedback();
    openFeedbackView();
    if (draft) { $('#fbText').value = draft; drawManifest(); }
  });
  $('#settingsFeedback').addEventListener('click', openFeedbackView);
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
  // Which build the browser is actually running, as opposed to which one was
  // last uploaded. A service worker makes those two different things.
  $('#appBuild').textContent = APP.build;
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

  async function refreshAIStatus() {
    const text = $('#aiStatusText');
    const dot = $('#aiStatus');
    text.textContent = 'Checking…';
    dot.dataset.state = 'wait';
    const msg = await AIClient.health();
    text.textContent = msg;
    dot.dataset.state = !AIClient.isLive || /^Connected/.test(msg) ? 'ok' : 'bad';
  }

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

  /* Asked after the card is drawn, never before it. A box that can only fail
     when ticked is worse than no box: the Cloudflare Worker implements none of
     the push routes and says so on /api/health, so on that deployment this
     switches itself off and explains, instead of throwing when pressed. */
  Push.offered().then((can) => {
    $('#pushToggle').disabled = !can;
    $('#pushNote').textContent = can
      ? 'Your proxy can push, so reminders arrive with the app closed.'
      : 'Your proxy does not do server push, so reminders arrive while VocabX is '
        + 'open in a tab — or any time in the installed Android app, which raises '
        + 'them itself. The Node proxy in vocab/server does push; the Cloudflare '
        + 'Worker does not.';
  });
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
