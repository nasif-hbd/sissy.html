/**
 * AI adapter.
 *
 * The browser never holds an Anthropic API key. In `proxy` mode every call
 * goes to your own server (see server/proxy.mjs), which owns the key and calls
 * the Claude API. In `mock` mode nothing leaves the device — the template stays
 * fully usable, and demoable, before anyone wires up a key.
 *
 * Wire protocol (both directions are ours, so it is deliberately small):
 *   JSON routes    → POST {…} ⇒ { ok: true, data: … } | { ok: false, error }
 *   Stream routes  → POST {…} ⇒ text/event-stream of
 *                    data: {"type":"text_delta","text":"…"}
 *                    data: {"type":"done"} | {"type":"error","error":"…"}
 */
import { AI } from './config.js';
import { Store } from './store.js';

const cfg = () => Store.state.settings.ai;

export const AIClient = {
  get mode() { return cfg().mode; },
  get isLive() { return cfg().mode === 'proxy'; },

  url(route) {
    const base = (cfg().endpoint || '').replace(/\/+$/, '');
    return `${base}${route}`;
  },

  /** Is the proxy reachable? Returns a short human-readable status string. */
  async health() {
    if (!this.isLive) return 'Offline mode — using built-in sample responses.';
    try {
      const res = await fetch(this.url(AI.routes.health), { signal: timeout(6000) });
      if (!res.ok) return `Proxy responded ${res.status}. Check the server logs.`;
      const body = await res.json();
      return body.hasKey
        ? `Connected — proxy ready, model ${body.model}.`
        : 'Proxy is up but has no ANTHROPIC_API_KEY set.';
    } catch {
      return 'Cannot reach the proxy. Is it running? (npm start in vocab/server)';
    }
  },

  // ── JSON calls ───────────────────────────────────────────────────────────

  /** Full dictionary entry for a word: definition, examples, mnemonic… */
  async enrichWord(term, opts = {}) {
    if (!this.isLive) return mockWord(term, opts.level);
    return post(this.url(AI.routes.word), { term, level: opts.level, model: cfg().model });
  },

  /** A multiple-choice item for `word`, with plausible distractors. */
  async quiz(word, pool, opts = {}) {
    if (!this.isLive) return mockQuiz(word, pool);
    return post(this.url(AI.routes.quiz), {
      term: word.term,
      definition: word.definition,
      distractors: pool.map((w) => w.term).slice(0, 8),
      level: opts.level,
      model: cfg().model,
    });
  },

  /** Words worth learning next, given what the learner already knows. */
  async suggest(opts = {}) {
    if (!this.isLive) return mockSuggest(opts);
    return post(this.url(AI.routes.suggest), {
      level: opts.level,
      known: opts.known || [],
      struggling: opts.struggling || [],
      count: opts.count || 6,
      model: cfg().model,
    });
  },

  // ── streaming calls ──────────────────────────────────────────────────────

  /** Feedback on a learner-written sentence. Streams tokens to `onToken`. */
  async coach({ term, definition, sentence, level }, onToken) {
    if (!this.isLive) return mockStream(mockCoach(term, sentence), onToken);
    return stream(this.url(AI.routes.coach),
      { term, definition, sentence, level, model: cfg().model }, onToken);
  },

  /** Weekly progress write-up from the tracking snapshot. */
  async report(payload, onToken) {
    if (!this.isLive) return mockStream(mockReport(payload), onToken);
    return stream(this.url(AI.routes.report), { stats: payload, model: cfg().model }, onToken);
  },
};

// ── transport ──────────────────────────────────────────────────────────────

function timeout(ms = AI.timeoutMs) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeout(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `AI request failed (${res.status})`);
  }
  return payload.data;
}

/** Reads an SSE body, calling `onToken` per delta; resolves with the full text. */
async function stream(url, body, onToken) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeout(),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `AI request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (evt.type === 'text_delta' && evt.text) { full += evt.text; onToken?.(evt.text); }
      else if (evt.type === 'error') throw new Error(evt.error || 'AI stream failed');
    }
  }
  return full;
}

// ── offline mode ───────────────────────────────────────────────────────────
// Deterministic, obviously-sample content. Enough shape for the UI to be real;
// never pretends to be a dictionary.

function mockWord(term, level = 'B1') {
  const t = term.trim().toLowerCase();
  return {
    term: t,
    phonetic: '',
    pos: 'unknown',
    level,
    definition: `Sample entry for “${t}”. Switch the AI mode to Proxy in Settings to get a real definition from Claude.`,
    examples: [
      `I keep meeting the word ${t} and I want it to stick.`,
      `Write your own sentence with ${t} here — the writing coach will mark it.`,
    ],
    synonyms: [],
    antonyms: [],
    mnemonic: `Link “${t}” to a picture you already have in your head — the sillier, the stickier.`,
    tags: ['custom'],
  };
}

function mockQuiz(word, pool) {
  const others = pool.filter((w) => w.id !== word.id).sort(() => Math.random() - 0.5).slice(0, 3);
  const options = [...others.map((w) => w.term), word.term].sort(() => Math.random() - 0.5);
  return {
    question: word.definition || `Which word means “${word.term}”?`,
    options,
    answerIndex: options.indexOf(word.term),
    // The question already carries the definition, so the note adds context
    // rather than repeating it.
    explanation: word.synonyms?.length
      ? `Close in sense to ${word.synonyms.slice(0, 2).join(' and ')}.`
      : 'Sample explanation — connect the proxy for a real one.',
  };
}

function mockSuggest({ level = 'B1' } = {}) {
  const bank = [
    ['nuance', 'a small but meaningful difference'],
    ['tangible', 'real enough to touch or measure'],
    ['adhere', 'to stick to a rule or a surface'],
    ['scarce', 'not enough to meet demand'],
    ['exempt', 'freed from a rule others must follow'],
    ['fluctuate', 'to rise and fall irregularly'],
    ['intricate', 'detailed and complicated'],
    ['persistent', 'continuing despite difficulty'],
  ];
  return bank.sort(() => Math.random() - 0.5).slice(0, 6)
    .map(([term, reason]) => ({ term, reason: `${reason} — typical ${level} vocabulary.` }));
}

function mockCoach(term, sentence) {
  const uses = sentence.toLowerCase().includes(term.toLowerCase().slice(0, Math.max(4, term.length - 2)));
  return [
    uses ? `Good — you used “${term}” in your own sentence.` : `I could not find “${term}” in that sentence. Try again using it directly.`,
    '',
    'Offline mode is on, so this is sample feedback rather than a real assessment.',
    'Turn on Proxy mode in Settings and Claude will check grammar, collocation and register,',
    'then rewrite your sentence one level more natural.',
  ].join('\n');
}

function mockReport(p = {}) {
  return [
    `Week in review — ${p.reviewsLast7Days ?? 0} reviews across ${p.activeDaysLast7 ?? 0} active days.`,
    '',
    `You are holding a ${p.streak ?? 0}-day streak and ${p.knownWords ?? 0} of ${p.deckSize ?? 0} words have moved into long-term review.`,
    p.strugglingWords?.length
      ? `Keep an eye on: ${p.strugglingWords.map((w) => w.term).join(', ')}.`
      : 'Nothing is badly stuck right now.',
    '',
    'This is sample text — connect the proxy for a real analysis of your data.',
  ].join('\n');
}

/** Replays canned text through the same token callback the live stream uses. */
async function mockStream(text, onToken) {
  for (const chunk of text.match(/\S+\s*/g) || [text]) {
    onToken?.(chunk);
    await new Promise((r) => setTimeout(r, 18));
  }
  return text;
}
