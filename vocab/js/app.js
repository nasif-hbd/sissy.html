/**
 * Lexio — controller.
 *
 * Owns session state (which card is on screen, which quiz question is live)
 * and wires every control to the modules that do the actual work:
 *   store.js  persistence      srs.js    scheduling
 *   stats.js  tracking         notify.js reminders
 *   ai.js     Claude calls     ui.js     rendering
 */
import { APP, AI as AICFG, THEMES } from './config.js';
import { Store, refreshStreak, makeSrs, dayKey } from './store.js';
import { schedule, buildQueue, bucket, plannedSession, queueCounts } from './srs.js';
import { makeSessionTimer, reportPayload, weakest, summary, window as windowStats, recentDays } from './stats.js';
import { Notifier, Push } from './notify.js';
import { AIClient } from './ai.js';
import {
  $, $$, el, icon, toast, applyTheme, switchView, renderHeader, renderQueueSummary,
  renderCard, renderEmptyQueue, renderWordList, renderProgress, renderSuggestions,
  renderModules, renderModuleDetail, renderHome, renderXp, practicePool, actionSheet,
  renderPlacementQuestion, renderPlacementResult, renderLevelSummary, renderChat, sizeChat,
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
  Store.init();
  refreshStreak(Store.state);
  applyTheme(Store.state.settings.theme);

  wireTabs();
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

  // The leaderboard names modules, so fetch the manifest quietly at boot.
  Catalog.modules().then((m) => { moduleManifest = m; drawXp(Store.state); }).catch(() => {});

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
  window.Lexio = { Store, Notifier, Push, AIClient, session, render, lesson: currentLesson, placement: () => placementRun };

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
function wireTabs() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      switchView(tab.dataset.tab);
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

function gradeCard(grade) {
  const word = currentWord();
  if (!word || !session.revealed) return;

  const rec = Store.state.srs[word.id] || makeSrs();
  const wasNew = rec.state === 'new';
  const next = schedule(rec, grade);

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

  const s = summary(Store.state);
  if (s.today.reviews === Store.state.settings.dailyGoal) {
    toast(`Day's quota met — ${s.today.reviews} reviews`);
    Notifier.show('Quota met', `${s.today.reviews} reviews today. Streak: ${s.streak} days.`, { actions: false });
  }

  nextCard();
  renderHeader(Store.state);
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
  $('#aiSlotTitle').textContent = AIClient.isLive ? 'Claude' : 'From the dictionary';
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
    body.textContent = `Could not reach Claude: ${err.message}`;
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
  $('#coachSubmit').addEventListener('click', runCoach);
  $('#coachNew').addEventListener('click', pickCoachWord);
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
  $('#coachOutput').hidden = true;
  $('#coachOutput').textContent = '';
}

async function runCoach() {
  const word = Store.state.words[session.coachWordId];
  const sentence = $('#coachInput').value.trim();
  if (!word) return;
  if (sentence.length < 6) { toast('Write a full sentence first.', 'bad'); return; }

  const out = $('#coachOutput');
  out.hidden = false;
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
    out.textContent = `Could not reach the AI: ${err.message}`;
  } finally {
    out.classList.remove('cursor');
    $('#coachSubmit').disabled = false;
  }
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
  }, { onModule: openModuleById });
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
  return Object.entries(lessons)
    .map(([id, sets]) => {
      const entry = moduleManifest.find((m) => m.id === id);
      if (!entry) return null;
      const results = Object.values(sets);
      return {
        id,
        title: entry.title,
        done: results.filter((r) => r?.passed).length,
        sets: Math.ceil((entry.count || 0) / SET_WORDS) || results.length,
        at: Math.max(0, ...results.map((r) => r?.at || 0)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, 4);
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
  const waiting = plan.due + plan.learning;
  if (waiting) return `Review ${waiting} word${waiting === 1 ? '' : 's'}`;
  if (plan.new) return `Learn ${plan.new} new word${plan.new === 1 ? '' : 's'}`;
  return 'Study ahead';
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
  hint.textContent = useAI ? 'Asking Claude for a definition…' : '';

  try {
    // 95,000 words ship with the app, so most additions never need the network.
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
  toast('Asking Claude…');
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
    ? 'Claude is connected — ask anything about English.'
    : 'Answering from the dictionary on your device. Turn on Claude in Settings for open questions.';
}

async function sendQuestion(text) {
  const question = String(text || '').trim();
  if (!question || chat.busy) return;

  $('#chatInput').value = '';
  $('#chatIntro').hidden = true;
  chat.busy = true;
  $('#chatSend').disabled = true;

  chat.messages.push({ role: 'you', text: question });
  const reply = { role: 'tutor', text: '', pending: true };
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
    reply.text = `Could not reach Claude: ${err.message}`;
    reply.failed = true;
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
  $('#assessSource').textContent = AIClient.isLive ? 'Claude' : 'Built-in';
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
    body.textContent = `Could not reach Claude: ${err.message}`;
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
      title: 'Lexio', body: 'This is what a reminder looks like.', view: 'learn',
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

  // AI — one choice, one status line, the server fields only when they matter.
  $('#aiEndpoint').value = s.ai.endpoint || AICFG.defaultEndpoint;
  const modelSelect = $('#aiModel');
  modelSelect.replaceChildren(...AICFG.models.map((m) =>
    el('option', { value: m.id, text: m.label })));
  modelSelect.value = s.ai.model || AICFG.defaultModel;

  const showAIMode = (mode) => {
    for (const btn of $$('#aiModePicker .seg__btn')) {
      btn.classList.toggle('is-active', btn.dataset.ai === mode);
    }
    $('#aiProxyFields').hidden = mode !== 'proxy';
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

  for (const btn of $$('#aiModePicker .seg__btn')) {
    btn.addEventListener('click', () => {
      Store.set('settings.ai.mode', btn.dataset.ai);
      showAIMode(btn.dataset.ai);
      refreshAIStatus();
    });
  }
  $('#aiEndpoint').addEventListener('change', (e) => {
    Store.set('settings.ai.endpoint', e.target.value.trim());
    refreshAIStatus();
  });
  modelSelect.addEventListener('change', (e) =>
    Store.set('settings.ai.model', e.target.value || AICFG.defaultModel));
  $('#aiTest').addEventListener('click', refreshAIStatus);

  showAIMode(s.ai.mode);
  refreshAIStatus();

  // data
  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([Store.export()], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `lexio-backup-${new Date().toISOString().slice(0, 10)}.json` });
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
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Delete all progress and restore the starter deck?')) return;
    Store.reset();
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
    : 'These fire while Lexio is open in a tab. For them to arrive with the app closed, turn on server push above.');
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

function wireKeyboard() {
  addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if ($('#view-learn').hidden) return;
    if (e.code === 'Space') { e.preventDefault(); session.revealed ? gradeCard(2) : reveal(); }
    else if (['1', '2', '3', '4'].includes(e.key) && session.revealed) gradeCard(Number(e.key) - 1);
    else if (e.key === 's') speak(currentWord()?.term);
  });
}

// Service worker asks the page to open a view when a notification is clicked.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'navigate' && e.data.view) switchView(e.data.view);
});

boot();
