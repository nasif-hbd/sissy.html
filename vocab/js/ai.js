/**
 * AI adapter.
 *
 * Two answers to every question. `built-in` answers on the device from the
 * dictionary and module packs that ship with the app (see local.js) — no
 * network, no key, and a real answer rather than a placeholder. `claude` sends
 * the same question to your own server, which holds the Anthropic API key and
 * calls the Claude API. The browser never holds a key either way.
 *
 * Wire protocol (both directions are ours, so it is deliberately small):
 *   JSON routes    → POST {…} ⇒ { ok: true, data: … } | { ok: false, error }
 *   Stream routes  → POST {…} ⇒ text/event-stream of
 *                    data: {"type":"text_delta","text":"…"}
 *                    data: {"type":"done"} | {"type":"error","error":"…"}
 */
import { AI } from './config.js';
import { Store } from './store.js';
import { localWord, localExplain, localCoach, localSuggest, localReport, localAssess } from './local.js';
import { localAnswer, OFFLINE_MISS } from './chat.js';

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
    if (!this.isLive) return 'Built-in tutor — answers come from the dictionary on this device.';
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
    if (!this.isLive) return localWord(term, opts.level);
    return post(this.url(AI.routes.word), { term, level: opts.level, model: cfg().model });
  },

  /** A multiple-choice item for `word`, with plausible distractors. */
  async quiz(word, pool, opts = {}) {
    if (!this.isLive) return localQuiz(word, pool);
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
    if (!this.isLive) return localSuggest(opts);
    return post(this.url(AI.routes.suggest), {
      level: opts.level,
      known: opts.known || [],
      struggling: opts.struggling || [],
      count: opts.count || 6,
      model: cfg().model,
    });
  },

  // ── streaming calls ──────────────────────────────────────────────────────

  /**
   * One explanation of a word — meaning, usage, memory hook. Streams so the
   * panel fills in the same way whichever half is answering.
   */
  async explain(word, onToken, opts = {}) {
    if (!this.isLive) return replay(localExplain(word, opts.level), onToken);
    return stream(this.url(AI.routes.coach), {
      term: word.term,
      definition: word.definition,
      level: opts.level,
      sentence: `Explain "${word.term}" to a ${opts.level || 'B1'} learner: two short sentences of plain English, one natural example sentence, then one memory hook.`,
      model: cfg().model,
    }, onToken);
  },

  /** Feedback on a learner-written sentence. Streams tokens to `onToken`. */
  async coach({ term, definition, sentence, level }, onToken) {
    if (!this.isLive) return replay(localCoach(term, sentence), onToken);
    return stream(this.url(AI.routes.coach),
      { term, definition, sentence, level, model: cfg().model }, onToken);
  },

  /**
   * An open question from the learner, with the conversation so far.
   *
   * Offline this answers from the dictionary where the question is about a
   * word, and says plainly when it cannot rather than guessing.
   */
  async ask({ question, history = [], level }, onToken) {
    if (!this.isLive) {
      const answer = await localAnswer(question).catch(() => null);
      return replay(answer || OFFLINE_MISS, onToken);
    }
    return stream(this.url(AI.routes.ask),
      { question, history, level, model: cfg().model }, onToken);
  },

  /**
   * The capability read-out after a placement exam. The plan itself is computed
   * in advice.js and passed in — Claude explains it, it does not invent it, so
   * the recommendation is the same whichever half is answering.
   */
  async assess(payload, onToken) {
    if (!this.isLive) return replay(localAssess(payload), onToken);
    return stream(this.url(AI.routes.assess), { ...payload, model: cfg().model }, onToken);
  },

  /** Weekly progress write-up from the tracking snapshot. */
  async report(payload, onToken) {
    if (!this.isLive) return replay(localReport(payload), onToken);
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

// ── the built-in half ──────────────────────────────────────────────────────
// localWord/localCoach/localSuggest/localReport live in local.js because they
// read the shipped data. Only these two need nothing but the arguments.

/** A multiple-choice item built from the learner's own deck. */
function localQuiz(word, pool) {
  const others = pool.filter((w) => w.id !== word.id).sort(() => Math.random() - 0.5).slice(0, 3);
  const options = [...others.map((w) => w.term), word.term].sort(() => Math.random() - 0.5);
  return {
    question: word.definition || `Which word means “${word.term}”?`,
    options,
    answerIndex: options.indexOf(word.term),
    explanation: word.synonyms?.length
      ? `Close in sense to ${word.synonyms.slice(0, 2).join(' and ')}.`
      : `“${word.term}” — ${word.definition || 'check the card for the full entry.'}`,
  };
}

/** Feeds text through the same token callback the live stream uses. */
async function replay(text, onToken) {
  const body = typeof text?.then === 'function' ? await text : text;
  for (const chunk of body.match(/\S+\s*/g) || [body]) {
    onToken?.(chunk);
    await new Promise((r) => setTimeout(r, 14));
  }
  return body;
}
