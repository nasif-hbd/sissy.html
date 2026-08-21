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
import { schedule, buildQueue, bucket } from './srs.js';
import { makeSessionTimer, reportPayload, weakest, summary } from './stats.js';
import { Notifier, Push } from './notify.js';
import { AIClient } from './ai.js';
import {
  $, $$, el, icon, toast, applyTheme, switchView, renderHeader, renderQueueSummary,
  renderCard, renderEmptyQueue, renderWordList, renderProgress, renderSuggestions,
  practicePool,
} from './ui.js';

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
  wireWords();
  wireProgress();
  wireSettings();
  wireKeyboard();

  Store.on(() => renderHeader(Store.state));
  render();

  $('#app').hidden = false;

  const startView = location.hash.replace('#', '');
  if ($$('.tab').some((t) => t.dataset.tab === startView)) switchView(startView);

  await Notifier.registerServiceWorker();
  if (Store.state.settings.reminders.enabled) Notifier.start();
  refreshNotifyState();

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
  window.Lexio = { Store, Notifier, Push, AIClient, session, render };

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
}

// ── tabs ───────────────────────────────────────────────────────────────────
function wireTabs() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      switchView(tab.dataset.tab);
      if (tab.dataset.tab === 'progress') renderProgress(Store.state);
      if (tab.dataset.tab === 'practice') ensurePracticeSeed();
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
  $('#explainBtn').addEventListener('click', () => aiCardHelp('explain'));
  $('#moreExamplesBtn').addEventListener('click', () => aiCardHelp('examples'));
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

function drawCurrentCard() {
  const state = Store.state;
  if (!session.currentId || !state.words[session.currentId]) {
    if (!session.queue.length) refillQueue();
    session.currentId = session.queue[0] || null;
  }
  const word = currentWord();
  if (!word) { renderEmptyQueue(state); return; }
  renderCard(word, state.srs[word.id], { revealed: session.revealed });
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
async function aiCardHelp(kind) {
  const word = currentWord();
  if (!word) return;
  const slot = $('#aiSlot');
  const body = $('#aiSlotBody');
  slot.hidden = false;
  $('#aiSlotTitle').textContent = kind === 'explain' ? 'Marginalia' : 'Further usage';
  body.textContent = '';
  body.classList.add('cursor');

  try {
    if (kind === 'explain') {
      await AIClient.coach({
        term: word.term, definition: word.definition, level: Store.state.profile.level,
        sentence: `Explain the word "${word.term}" to a ${Store.state.profile.level} learner in two short sentences, then give one memory hook.`,
      }, (t) => { body.textContent += t; });
    } else {
      const data = await AIClient.enrichWord(word.term, { level: Store.state.profile.level });
      const examples = (data.examples || []).slice(0, 3);
      body.textContent = examples.map((e) => `• ${e}`).join('\n');
      if (examples.length) {
        Store.updateWord(word.id, {
          examples: [...new Set([...(word.examples || []), ...examples])].slice(0, 5),
        });
      }
    }
  } catch (err) {
    body.textContent = `Could not reach the AI: ${err.message}`;
  } finally {
    body.classList.remove('cursor');
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
    const payload = useAI
      ? await AIClient.enrichWord(term, { level: Store.state.profile.level })
      : { term };
    Store.addWord({ ...payload, term }, useAI ? `ai:${AIClient.mode}` : 'user');
    toast(`Added “${term}”.`);
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
  const rec = Store.state.srs[word.id];
  const action = prompt(
    `“${word.term}” — ${bucket(rec)}\n\n` +
    '1  Study now\n2  Reset progress\n3  Refresh with AI\n4  Delete\n\nType a number:',
    '1');
  if (action === '1') openWord(word);
  else if (action === '2') { Store.commit((s) => { s.srs[word.id] = makeSrs(); }); toast('Progress reset.'); render(); }
  else if (action === '3') refreshWithAI(word);
  else if (action === '4') {
    if (confirm(`Delete “${word.term}” and its progress?`)) { Store.deleteWord(word.id); render(); }
  }
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
  $('#notifyTest').addEventListener('click', async () => {
    const sent = await Notifier.show('Lexio', 'This is what a reminder looks like.', { actions: false });
    if (!sent) toast('Enable notifications first.', 'bad');
  });
  $('#addTimeBtn').addEventListener('click', () => {
    const value = $('#newTime').value;
    if (!value) return;
    Store.commit((st) => {
      const times = st.settings.reminders.times;
      if (!times.includes(value)) times.push(value);
      times.sort();
    });
    renderTimes();
    Notifier.start();
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

  // AI
  const mode = $('#aiMode');
  mode.value = s.ai.mode;
  $('#aiEndpoint').value = s.ai.endpoint || AICFG.defaultEndpoint;
  $('#aiModel').value = s.ai.model || AICFG.defaultModel;
  const syncAIFields = () => {
    const live = $('#aiMode').value === 'proxy';
    $('#endpointField').hidden = !live;
    $('#modelField').hidden = !live;
  };
  mode.addEventListener('change', async (e) => {
    Store.set('settings.ai.mode', e.target.value);
    syncAIFields();
    $('#aiStatus').textContent = await AIClient.health();
  });
  $('#aiEndpoint').addEventListener('change', async (e) => {
    Store.set('settings.ai.endpoint', e.target.value.trim());
    $('#aiStatus').textContent = await AIClient.health();
  });
  $('#aiModel').addEventListener('change', (e) =>
    Store.set('settings.ai.model', e.target.value.trim() || AICFG.defaultModel));
  syncAIFields();
  AIClient.health().then((msg) => { $('#aiStatus').textContent = msg; });

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

  renderTimes();
}

function renderTimes() {
  const times = Store.state.settings.reminders.times || [];
  $('#reminderTimes').replaceChildren(...times.map((t) =>
    el('span', { class: 'time-chip' }, t,
      el('button', {
        'aria-label': `Remove ${t}`,
        onclick: () => {
          Store.commit((s) => {
            s.settings.reminders.times = s.settings.reminders.times.filter((x) => x !== t);
          });
          renderTimes();
        },
      }, icon('close')))));
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
