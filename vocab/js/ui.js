/**
 * Rendering.
 *
 * The shell in index.html is static; these functions fill it from state. No
 * framework — every renderer is idempotent, so `render()` can be called on any
 * state change without diffing.
 */
import { bucket, previewIntervals, formatDelta, queueCounts, forecast } from './srs.js';
import { summary, heatmap, recentDays, masteryBreakdown, weakest } from './stats.js';

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

export function switchView(name) {
  for (const view of $$('.view')) view.hidden = view.dataset.view !== name;
  for (const tab of $$('.tab')) tab.classList.toggle('is-active', tab.dataset.tab === name);
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

// ── progress ───────────────────────────────────────────────────────────────

export function renderProgress(state) {
  const s = summary(state);
  $('#tStreak').textContent = s.streak;
  $('#tStreakFoot').textContent = `best ${s.longest}`;
  $('#tKnown').textContent = s.known;
  $('#tKnownFoot').textContent = `of ${s.total} words`;
  $('#tAccuracy').textContent = s.accuracy7 == null ? '—' : `${Math.round(s.accuracy7 * 100)}%`;
  $('#tReviews').textContent = s.reviews7;
  $('#tReviewsFoot').textContent = `≈${s.perDay}/day · ${s.minutes7} min`;

  // heatmap
  $('#heatmap').replaceChildren(...heatmap(state, 12).map((c) =>
    el('i', { 'data-l': c.level, title: `${c.key}: ${c.count} review${c.count === 1 ? '' : 's'}` })));

  // 14-day bars
  const days = recentDays(state, 14);
  const peak = Math.max(1, ...days.map((d) => d.reviews));
  $('#bars').replaceChildren(...days.map((d) =>
    el('div', { class: 'bar', title: `${d.key}: ${d.reviews} reviews` },
      el('i', {
        class: d.reviews ? '' : 'is-empty',
        style: `height:${d.reviews ? Math.max(6, (d.reviews / peak) * 100) : 2}%`,
      }),
      el('span', { text: d.label }))));

  // mastery bar
  const m = masteryBreakdown(state);
  const total = Math.max(1, Object.values(m).reduce((a, b) => a + b, 0));
  // Colours come from the stylesheet's tokens — keep these names in sync with
  // the palette block at the top of styles.css.
  const order = [
    ['mastered', 'var(--ok)'], ['review', 'var(--info)'],
    ['learning', 'var(--warn)'], ['leech', 'var(--danger)'], ['new', 'var(--rule-firm)'],
  ];
  $('#mastery').replaceChildren(...order.map(([k, colour]) =>
    el('i', { style: `width:${(m[k] / total) * 100}%;background:${colour}`, title: `${k}: ${m[k]}` })));
  $('#masteryLegend').replaceChildren(...order.map(([k, colour]) =>
    el('span', {}, el('i', { class: 'dot', style: `background:${colour}` }), `${k} ${m[k]}`)));

  // forecast
  const fc = forecast(state, 7);
  const fpeak = Math.max(1, ...fc);
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
  $('#moduleProgress').textContent = `${done} of ${sets.length} sets passed · ${module.count} words in total`;

  const firstUnfinished = sets.findIndex((_, i) => !results[i]?.passed);
  $('#moduleSets').replaceChildren(...sets.map((words, i) => {
    const result = results[i];
    const classes = ['set',
      result?.passed ? 'is-passed' : '',
      i === firstUnfinished ? 'is-current' : ''].filter(Boolean).join(' ');
    return el('button', { class: classes, type: 'button', onclick: () => handlers.onStart?.(i) },
      el('span', { class: 'set__num', text: String(i + 1) }),
      el('div', { class: 'set__body' },
        el('div', { class: 'set__title', text: `Set ${i + 1}` }),
        el('div', { class: 'set__words', text: words.slice(0, 4).map((w) => w.term).join(', ') + '…' })),
      el('span', { class: 'set__score', text: result ? `${result.best}%` : `${words.length} words` }));
  }));
}

/** The home screen: today, then the wider picture. */
export function renderHome(data) {
  $('#homeToday').textContent = data.todayLine;
  $('#homeGoalFill').style.width = `${Math.round(data.goalPct * 100)}%`;
  $('#homeGoalHint').textContent = data.goalHint;
  $('#homeStart').textContent = data.startLabel;

  $('#homeWeek').textContent = data.week.reviews;
  $('#homeWeekFoot').textContent = `reviews · ${data.week.xp} XP`;
  $('#homeMonth').textContent = data.month.reviews;
  $('#homeMonthFoot').textContent = `reviews · ${data.month.xp} XP`;
  $('#homeStreak').textContent = data.streak;
  $('#homeStreakFoot').textContent = data.streak === 1 ? 'day in a row' : 'days in a row';
  $('#homeLearned').textContent = data.learned;
  $('#homeLearnedFoot').textContent = `of ${data.total} words`;

  const peak = Math.max(1, ...data.days.map((d) => d.reviews));
  $('#homeBars').replaceChildren(...data.days.map((d) =>
    el('div', { class: 'bar', title: `${d.key}: ${d.reviews} reviews` },
      el('i', {
        class: d.reviews ? '' : 'is-empty',
        style: `height:${d.reviews ? Math.max(6, (d.reviews / peak) * 100) : 3}%`,
      }),
      el('span', { text: d.label }))));

  $('#homeContinueCard').hidden = !data.continue;
  if (data.continue) $('#homeContinueText').textContent = data.continue.text;
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
