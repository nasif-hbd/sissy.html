/**
 * Rendering.
 *
 * The shell in index.html is static; these functions fill it from state. No
 * framework — every renderer is idempotent, so `render()` can be called on any
 * state change without diffing.
 */
import { bucket, previewIntervals, formatDelta, queueCounts, forecast } from './srs.js';
import { summary, heatmap, masteryBreakdown, weakest } from './stats.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** An icon from the sheet in index.html. SVG needs its own namespace. */
export function icon(name, cls = 'ico') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

// ── chrome ─────────────────────────────────────────────────────────────────

export function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind ? 'is-' + kind : ''}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 250); }, 2600);
}

export function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const dark = theme === 'ink' ||
    (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('is-dark', dark);
  // Read the browser chrome colour back out of the palette that just applied,
  // so a new theme needs no second place to declare it.
  const paper = getComputedStyle(root).getPropertyValue('--paper').trim();
  $('meta[name="theme-color"]')?.setAttribute('content', paper || '#ffffff');
}

/** Views where a "reviews done today" bar means something. */
const GOAL_VIEWS = new Set(['learn', 'practice', 'lesson']);

export function switchView(name) {
  for (const view of $$('.view')) view.hidden = view.dataset.view !== name;
  for (const tab of $$('.tab')) tab.classList.toggle('is-active', tab.dataset.tab === name);
  // Home draws its own, larger version of the goal meter, and on Settings or
  // Words the bar was just a line of furniture on every screen.
  $('#goalbar').hidden = !GOAL_VIEWS.has(name);
  window.scrollTo({ top: 0, behavior: 'instant' });
  location.hash = name;
}

// ── header + goal ──────────────────────────────────────────────────────────

export function renderHeader(state) {
  const s = summary(state);
  $('#streakCount').textContent = s.streak;
  $('#streakChip').classList.toggle('is-cold', s.streak === 0);
  $('#brandSub').textContent = `${s.total} words · ${s.known} learned`;

  const goal = state.settings.dailyGoal;
  const done = s.today.reviews;
  const pct = Math.min(100, goal ? (done / goal) * 100 : 0);
  const fill = $('#goalFill');
  fill.style.width = `${pct}%`;
  fill.classList.toggle('is-done', done >= goal);
  $('#goalLabel').textContent = done >= goal
    ? `Daily goal reached — ${done} reviews`
    : `${done} of ${goal} reviews today`;
}

// ── learn ──────────────────────────────────────────────────────────────────

export function renderQueueSummary(state) {
  const c = queueCounts(state);
  $('#qDue').textContent = c.due;
  $('#qNew').textContent = c.new;
  $('#qLearning').textContent = c.learning;
  return c;
}

export function renderCard(word, rec, { revealed = false } = {}) {
  $('#flashcard').hidden = false;
  $('#learnEmpty').hidden = true;

  $('#cardState').textContent = bucket(rec);
  $('#cardPos').textContent = word.pos || '';
  $('#cardPos').hidden = !word.pos;
  $('#cardLevel').textContent = word.level || '';
  $('#cardLevel').hidden = !word.level;
  $('#cardTerm').textContent = word.term;
  $('#cardPhonetic').textContent = word.phonetic || '';

  $('#cardDefinition').textContent = word.definition || 'No definition yet — tap “Explain simply” for one.';
  $('#cardTranslation').hidden = true;   // filled in asynchronously by app.js

  const examples = $('#cardExamples');
  examples.replaceChildren(...(word.examples || []).map((ex) => el('li', {}, highlight(ex, word.term))));

  const syn = $('#cardSynonyms');
  syn.replaceChildren(...(word.synonyms || []).map((s) => el('span', { class: 'chip', text: s })));

  $('#cardMnemonicBox').hidden = !word.mnemonic;
  $('#cardMnemonic').textContent = word.mnemonic || '';

  $('#aiSlot').hidden = true;
  $('#aiSlotBody').textContent = '';

  $('#cardBack').hidden = !revealed;
  $('#revealBtn').hidden = revealed;
  $('#grades').hidden = !revealed;
  $('#cardTools').hidden = !revealed;

  if (revealed) {
    const p = previewIntervals(rec);
    $('#etaAgain').textContent = p.again;
    $('#etaHard').textContent = p.hard;
    $('#etaGood').textContent = p.good;
    $('#etaEasy').textContent = p.easy;
  }
}

export function renderEmptyQueue(state) {
  $('#flashcard').hidden = true;
  $('#learnEmpty').hidden = false;
  const c = queueCounts(state);
  const total = Object.keys(state.words).length;
  $('#learnEmptyText').textContent = total === 0
    ? 'No words yet. Open Modules and start a set, or add a word from the Words tab.'
    : c.new > 0
      ? `Nothing to review right now. ${c.new} new word${c.new === 1 ? ' is' : 's are'} ready whenever you want them.`
      : 'Nothing to review right now. Come back later — we will remind you.';
}

/** Bold the target word inside an example sentence. */
function highlight(sentence, term) {
  const stem = term.replace(/(ise|ize|ate|ing|ed|s)$/i, '');
  const re = new RegExp(`(${escapeRe(stem)}\\w*)`, 'ig');
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of sentence.matchAll(re)) {
    frag.append(sentence.slice(last, m.index), el('b', { text: m[0] }));
    last = m.index + m[0].length;
  }
  frag.append(sentence.slice(last));
  return frag;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── words ──────────────────────────────────────────────────────────────────

export function renderWordList(state, { query = '', filter = 'all' }, handlers = {}) {
  const list = $('#wordList');
  const q = query.trim().toLowerCase();

  const rows = Object.values(state.words)
    .filter((w) => {
      const b = bucket(state.srs[w.id]);
      if (filter !== 'all' && b !== filter) return false;
      if (!q) return true;
      return w.term.toLowerCase().includes(q) || (w.definition || '').toLowerCase().includes(q);
    })
    .sort((a, b) => (state.srs[a.id]?.due || 0) - (state.srs[b.id]?.due || 0));

  if (!rows.length) {
    list.replaceChildren(el('p', { class: 'hint', text: 'No words match this filter.' }));
    return;
  }

  list.replaceChildren(...rows.map((w) => {
    const rec = state.srs[w.id];
    const b = bucket(rec);
    return el('div', { class: 'word' },
      el('span', { class: `dot dot--${b}`, title: b }),
      el('div', { class: 'word__main', onclick: () => handlers.onOpen?.(w) },
        el('div', { class: 'word__term', text: w.term }),
        el('div', { class: 'word__def', text: w.definition || 'No definition yet' })),
      el('div', { class: 'word__meta' },
        el('span', { class: 'word__due', text: rec?.state === 'new' ? 'new' : formatDelta(rec.due - Date.now()) }),
        el('button', {
          class: 'btn btn--quiet btn--sm', 'aria-label': `Options for ${w.term}`,
          onclick: () => handlers.onMenu?.(w),
        }, icon('dots'))));
  }));
}

/**
 * A small sheet of choices, anchored to the bottom of the screen.
 *
 * This replaces a `prompt()` that asked the learner to read four numbered lines
 * and type a digit. Each action is `{ label, icon, danger, run }`.
 */
export function actionSheet(title, actions) {
  const close = () => wrap.remove();
  const wrap = el('div', { class: 'sheet', onclick: (e) => { if (e.target === wrap) close(); } },
    el('div', { class: 'sheet__panel' },
      el('p', { class: 'sheet__title', text: title }),
      ...actions.map((a) => el('button', {
        class: `sheet__btn${a.danger ? ' sheet__btn--danger' : ''}`,
        type: 'button',
        onclick: () => { close(); a.run(); },
      }, a.icon ? icon(a.icon) : '', a.label)),
      el('button', { class: 'sheet__btn sheet__btn--cancel', type: 'button', onclick: close }, 'Cancel')));

  document.addEventListener('keydown', function esc(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', esc);
    close();
  });
  document.body.append(wrap);
  wrap.querySelector('.sheet__btn')?.focus();
}

// ── progress ───────────────────────────────────────────────────────────────

export function renderProgress(state) {
  const s = summary(state);
  $('#tAccuracy').textContent = s.accuracy7 == null ? '—' : `${Math.round(s.accuracy7 * 100)}%`;
  $('#tStreak').textContent = s.longest;
  $('#tKnown').textContent = s.known;

  // heatmap
  $('#heatmap').replaceChildren(...heatmap(state, 12).map((c) =>
    el('i', { 'data-l': c.level, title: `${c.key}: ${c.count} review${c.count === 1 ? '' : 's'}` })));

  // mastery bar
  const m = masteryBreakdown(state);
  const total = Math.max(1, Object.values(m).reduce((a, b) => a + b, 0));
  // Colours come from the stylesheet's tokens — keep these names in sync with
  // the palette block at the top of styles.css.
  const order = [
    ['mastered', 'var(--ok)'], ['review', 'var(--info)'],
    ['learning', 'var(--warn)'], ['leech', 'var(--danger)'], ['new', 'var(--rule-firm)'],
  ];
  // The stats keep the SRS names; the legend says them in English.
  const plain = { mastered: 'known', review: 'in review', learning: 'learning', leech: 'tricky', new: 'not started' };
  $('#mastery').replaceChildren(...order.map(([k, colour]) =>
    el('i', { style: `width:${(m[k] / total) * 100}%;background:${colour}`, title: `${k}: ${m[k]}` })));
  $('#masteryLegend').replaceChildren(...order.map(([k, colour]) =>
    el('span', {}, el('i', { class: 'dot', style: `background:${colour}` }), `${plain[k]} ${m[k]}`)));

  // forecast
  const fc = forecast(state, 7);
  const fpeak = Math.max(1, ...fc);
  const anyDue = fc.some(Boolean);
  $('#forecast').hidden = !anyDue;
  $('#forecastEmpty').hidden = anyDue;
  const labels = ['today', ...Array.from({ length: 6 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + i + 1);
    return d.toLocaleDateString(undefined, { weekday: 'narrow' });
  })];
  $('#forecast').replaceChildren(...fc.map((n, i) =>
    el('div', { class: 'bar', title: `${n} card${n === 1 ? '' : 's'}` },
      el('i', { class: n ? '' : 'is-empty', style: `height:${n ? Math.max(6, (n / fpeak) * 100) : 2}%` }),
      el('span', { text: labels[i] }))));
}

export function renderSuggestions(items, onPick) {
  $('#suggestions').replaceChildren(...items.map((it) =>
    el('button', {
      class: 'chip', title: it.reason || '', onclick: () => onPick(it),
    }, `+ ${it.term}`)));
}

/**
 * The Modules tab. Each module shows how much of it is already in the deck, so
 * adding more is an obvious next step rather than a guess.
 */
export function renderModules(list, handlers = {}) {
  const node = $('#moduleList');
  if (!list.length) {
    node.replaceChildren(el('p', { class: 'hint', text: 'No modules found.' }));
    return;
  }
  node.replaceChildren(...list.map((m) => {
    const pct = m.sets ? Math.round((m.setsDone / m.sets) * 100) : 0;
    return el('button', { class: 'module', type: 'button', onclick: () => handlers.onOpen?.(m) },
      el('div', { class: 'module__head' },
        el('h3', { class: 'module__title', text: m.title }),
        el('span', { class: 'pill pill--ghost', text: m.level || '' })),
      el('p', { class: 'module__blurb', text: m.blurb }),
      el('div', { class: 'module__meter' }, el('i', { style: `width:${pct}%` })),
      el('div', { class: 'module__foot' },
        el('span', { class: 'module__count', text: `${m.setsDone} of ${m.sets} sets done` }),
        el('span', { class: 'module__count', text: `${m.count} words` })));
  }));
}

/** One module opened: its sets of ten, in order, with the marks so far. */
export function renderModuleDetail(module, sets, results, handlers = {}) {
  $('#moduleTitle').textContent = module.title;
  $('#moduleBlurb').textContent = module.blurb;

  const done = sets.filter((_, i) => results[i]?.passed).length;
  $('#moduleFill').style.width = `${Math.round((done / Math.max(1, sets.length)) * 100)}%`;
  $('#moduleProgress').textContent = done
    ? `${done} of ${sets.length} sets passed · ${module.count} words in the module`
    : `${sets.length} sets of ten · ${module.count} words in the module`;

  // One obvious next move. The grid below is for jumping around, not for
  // choosing where to begin — 40 identical rows made that decision for nobody.
  const next = sets.findIndex((_, i) => !results[i]?.passed);
  const target = next === -1 ? 0 : next;
  $('#moduleStart').textContent = next === -1
    ? 'Every set passed — study set 1 again'
    : `${done ? 'Continue' : 'Start'} — set ${target + 1} of ${sets.length}`;
  $('#moduleStart').onclick = () => handlers.onStart?.(target);
  $('#moduleNextWords').textContent = (sets[target] || [])
    .slice(0, 5).map((w) => w.term).join(' · ');

  $('#moduleSetsHint').textContent = `${done}/${sets.length} passed`;
  $('#moduleSets').replaceChildren(...sets.map((words, i) => {
    const result = results[i];
    const classes = ['chip-set',
      result?.passed ? 'is-passed' : '',
      i === target ? 'is-current' : ''].filter(Boolean).join(' ');
    return el('button', {
      class: classes,
      type: 'button',
      title: `Set ${i + 1} — ${words.slice(0, 4).map((w) => w.term).join(', ')}${result ? ` (best ${result.best}%)` : ''}`,
      onclick: () => handlers.onStart?.(i),
    }, String(i + 1));
  }));
}

/** The home screen: what to do now, the habit, where you stand, and the path. */
export function renderHome(data, handlers = {}) {
  $('#homeCount').textContent = data.countLine;

  const meter = $('#homeGoalFill');
  meter.style.width = `${Math.round(data.goalPct * 100)}%`;
  meter.classList.toggle('is-done', Boolean(data.goalDone));
  // An empty track is a grey bar that says nothing; it appears once there is
  // something in it to read.
  meter.parentElement.hidden = data.goalPct === 0;
  $('#homeGoalHint').textContent = data.goalHint;
  $('#homeGoalHint').hidden = !data.goalHint;
  $('#homeStart').textContent = data.startLabel;

  drawWeek(data);
  drawStanding(data);
  drawMods(data, handlers);

  $('#homeStats').textContent = data.stats;
}

/**
 * The streak, and the week that produced it.
 *
 * Seven days as filled or hollow marks reads at a glance and carries the same
 * information the old bar chart did — but a week with two study days looks like
 * a week with two study days rather than like an empty chart.
 */
function drawWeek(data) {
  $('#homeStreakBig').textContent = data.streak;
  $('#homeStreakWord').textContent = data.streak === 1 ? 'day in a row' : 'days in a row';
  $('#homeStreakBig').parentElement.classList.toggle('is-cold', data.streak === 0);
  $('#homeWeekCount').textContent = data.week.reviews
    ? `${data.week.reviews} review${data.week.reviews === 1 ? '' : 's'} this week`
    : 'nothing this week yet';

  const last = data.days.length - 1;
  $('#homeWeek').replaceChildren(...data.days.map((d, i) => el('div', {
    class: ['day', d.reviews ? 'is-on' : '', i === last ? 'is-today' : ''].filter(Boolean).join(' '),
    title: `${d.key}: ${d.reviews} review${d.reviews === 1 ? '' : 's'}`,
  }, el('i', {}), el('span', { text: d.label }))));
}

/** The XP level earned, and the CEFR level measured — two different things. */
function drawStanding(data) {
  $('#homeXpLevel').textContent = data.xp.level;
  $('#homeXpTitle').textContent = data.xp.title;
  $('#homeXpNext').textContent = `${data.xp.need - data.xp.into} XP to level ${data.xp.level + 1} · ${data.xp.total} earned`;
  $('#homeXpFill').style.width = `${Math.round(data.xp.pct * 100)}%`;

  // The badge carries the measured CEFR level. Before the check is sat there is
  // nothing to carry, and a big "?" sitting beside "Level 3" read as though the
  // XP level itself were unknown — so it stays away until it means something.
  const badge = $('#homeLevelBadge');
  badge.hidden = !data.placement;
  if (data.placement) badge.textContent = data.placement.level;
}

/**
 * Modules with work in them, most recently touched first, plus one Continue
 * button for the set the learner was part-way through.
 */
function drawMods(data, handlers) {
  const rows = data.mods || [];
  $('#homeMods').replaceChildren(...rows.map((m) => el('button', {
    class: 'mod', type: 'button', onclick: () => handlers.onModule?.(m),
  },
    el('div', { class: 'mod__head' },
      el('span', { class: 'mod__name', text: m.title }),
      el('span', { class: 'mod__count', text: `${m.done}/${m.sets}` })),
    el('div', { class: 'module__meter' },
      el('i', { style: `width:${Math.round((m.done / Math.max(1, m.sets)) * 100)}%` })))));

  $('#homeModsEmpty').hidden = rows.length > 0;
  $('#homeContinue').hidden = !data.continue;
  if (data.continue) $('#homeContinue').textContent = data.continue.label;
}

// ── the level check ────────────────────────────────────────────────────────

/** One question of the placement exam. */
export function renderPlacementQuestion(run, question, onAnswer) {
  $('#assessIntro').hidden = true;
  $('#assessResult').hidden = true;
  $('#assessExam').hidden = false;

  const n = run.asked.length + 1;
  $('#assessCount').textContent = `${n} of ${run.length}`;
  $('#assessFill').style.width = `${Math.round(((n - 1) / run.length) * 100)}%`;
  $('#assessBand').textContent = BAND_LABEL[question.band] || question.band;
  $('#assessPrompt').textContent = question.prompt;

  $('#assessOptions').replaceChildren(...question.options.map((text, i) =>
    el('button', { class: 'option', type: 'button', onclick: () => onAnswer(i) }, text)));
}

const BAND_LABEL = {
  Easy: 'Everyday', Moderate: 'Common', Advanced: 'Academic', 'God Level': 'Rare',
};

/** The result screen: level, band bars, plan, modules. */
export function renderPlacementResult(estimate, plan, handlers = {}) {
  $('#assessIntro').hidden = true;
  $('#assessExam').hidden = true;
  $('#assessResult').hidden = false;

  $('#assessLevel').textContent = estimate.level;
  $('#assessLevelLine').textContent = estimate.reached
    ? `${estimate.correct} of ${estimate.answered} right · ${CONFIDENCE[estimate.confidence]}`
    : `${estimate.correct} of ${estimate.answered} right — not enough to place you higher yet`;

  const known = estimate.knownWords;
  $('#assessKnown').textContent = known
    ? `Around ${known.known.toLocaleString()} of the ${known.total.toLocaleString()} words in these modules. An estimate from ${estimate.answered} questions, not a measure of your whole English.`
    : '';

  drawBands($('#assessBands'), estimate.perBand, true);

  $('#assessPace').textContent = plan.paceWhy;
  $('#assessChanges').replaceChildren(...planLines(plan).map((t) => el('li', { text: t })));
  $('#assessApply').hidden = false;
  $('#assessApplied').hidden = true;

  $('#assessModules').replaceChildren(...plan.modules.map((m) =>
    el('button', { class: 'pick', type: 'button', onclick: () => handlers.onModule?.(m) },
      el('div', { class: 'pick__title', text: m.title }),
      el('div', { class: 'pick__why', text: m.why }))));

  $('#assessRevisitCard').hidden = !plan.revisit.length;
  $('#assessRevisit').replaceChildren(...plan.revisit.map((t) =>
    el('span', { class: 'chip', text: t })));
}

const CONFIDENCE = { good: 'a firm result', fair: 'reasonably firm', rough: 'provisional' };

/** What the plan would set, said plainly. */
function planLines(plan) {
  const lines = [
    `Level ${plan.level}`,
    `${plan.newPerDay} new words a day`,
    `${plan.dailyGoal} reviews a day`,
  ];
  return [...lines, ...plan.notes];
}

/** Accuracy per difficulty band. Bands never asked about say so. */
function drawBands(node, perBand, wide) {
  node.replaceChildren(...perBand.map((b) => {
    const pct = b.accuracy == null ? 0 : Math.round(b.accuracy * 100);
    const state = b.accuracy == null ? 'is-unasked' : b.accuracy >= 0.7 ? 'is-held' : 'is-weak';
    return el('div', { class: `band ${state}` },
      el('span', { class: 'band__name', text: `${b.label} · ${b.cefr}` }),
      el('div', { class: 'band__track' }, el('i', { style: `width:${pct}%` })),
      el('span', {
        class: 'band__score',
        text: b.accuracy == null ? '—' : wide ? `${pct}% of ${b.seen}` : `${pct}%`,
      }));
  }));
}

/** The level summary shown on Home and Progress without re-sitting the exam. */
export function renderLevelSummary(placement) {
  const home = $('#homeLevelBadge');
  home.hidden = !placement;
  if (placement) home.textContent = placement.level;
  const onProgress = $('#progressLevelBadge');
  if (onProgress) onProgress.textContent = placement ? placement.level : '?';

  const when = placement
    ? new Date(placement.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : null;
  // The button already says "Check my level" when there is nothing to report,
  // so an extra line saying the same is noise.
  const line = $('#homeLevelLine');
  line.hidden = !placement;
  if (placement) line.textContent = `Measured ${placement.level} on ${when}`;
  $('#homeAssess').textContent = placement ? 'Check again' : 'Check my level';

  const progressLine = $('#progressLevelLine');
  if (progressLine) {
    progressLine.textContent = placement
      ? `${placement.level} on ${when} — ${placement.correct} of ${placement.answered} right, ${CONFIDENCE[placement.confidence]}.`
      : 'You have not sat the level check yet.';
  }
  const bands = $('#progressBands');
  if (bands) {
    bands.hidden = !placement;
    if (placement) drawBands(bands, placement.perBand, false);
  }
  $('#progressAssess').textContent = placement ? 'Check again' : 'Check my level';
}

/** The level card and the two boards under it. */
export function renderXp(standing, modules, days, totalXp) {
  $('#xpLevel').textContent = standing.level;
  $('#xpTitle').textContent = standing.title;
  $('#xpTotal').textContent = `${totalXp.toLocaleString()} XP`;
  $('#xpFill').style.width = `${Math.round(standing.pct * 100)}%`;
  $('#xpNext').textContent = `${standing.need - standing.into} XP to level ${standing.level + 1}`;

  const rows = (node, items, empty) => {
    if (!items.length) {
      node.replaceChildren(el('p', { class: 'hint', text: empty }));
      return;
    }
    node.replaceChildren(...items.map((item, i) =>
      el('div', { class: 'board__row' },
        el('span', { class: 'board__rank', text: String(i + 1) }),
        el('div', { class: 'board__name' },
          item.name,
          el('div', { class: 'board__sub', text: item.sub })),
        el('span', { class: 'board__xp', text: `${item.xp.toLocaleString()} XP` }))));
  };

  rows($('#boardModules'), modules, 'Finish a set and its points will show up here.');
  rows($('#boardDays'), days, 'Review some words and your best days will appear.');
}

/** Words to drill in Practice: prefer the ones being got wrong. */
export function practicePool(state, size = 12) {
  const weak = weakest(state, size).map((w) => state.words[w.id]).filter(Boolean);
  const rest = Object.values(state.words).filter((w) => !weak.includes(w));
  return [...weak, ...rest.sort(() => Math.random() - 0.5)].slice(0, Math.max(size, 4));
}
