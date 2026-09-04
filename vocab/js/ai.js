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
import { AI, PROVIDERS } from './config.js';
import { Store } from './store.js';
import { localWord, localExplain, localCoach, localSuggest, localReport, localAssess } from './local.js';
import { localAnswer, OFFLINE_MISS } from './chat.js';

const cfg = () => Store.state.settings.ai;

/**
 * Where the AI server is, for this build.
 *
 * Read from config, never from stored settings. It is a fact about the
 * deployment — one address, decided by whoever built it — not a preference,
 * and a published app must not let a visitor point it somewhere else.
 */
export const proxyBase = () => baseOf(AI.proxyUrl);

/**
 * An address, less anything that is not the address.
 *
 * The base is what the app appends its routes to, so a trailing `/api/...`
 * has to come off — the health-check URL is exactly what anyone setting this
 * up has in their clipboard, and pasting it produced a request for
 * /api/health/api/health and a 404 that blamed the server.
 */
export function baseOf(endpoint) {
  return String(endpoint || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api(\/[\w-]*)*$/i, '');
}

export const AIClient = {
  get mode() { return cfg().mode; },
  /**
   * Which engine is answering. `mode` is kept for older saved settings, where
   * 'proxy' always meant Claude.
   */
  get provider() {
    const p = cfg().provider || (cfg().mode === 'proxy' ? 'anthropic' : 'built-in');
    return PROVIDERS[p] ? p : 'built-in';
  },
  get isLive() { return this.provider !== 'built-in'; },
  get providerLabel() { return PROVIDERS[this.provider]?.label || 'Built-in'; },
  /**
   * The model id for whichever engine is answering.
   *
   * Settings keeps the two picks apart — `model` is the Claude one, and
   * `geminiModel` the Gemini one — and every call used to send `model`
   * whichever engine was chosen. Gemini was being asked for
   * "claude-haiku-4-5", which it answers 404 to, so the Gemini engine could
   * not complete a single request from the browser and its model menu did
   * nothing at all.
   */
  get model() {
    return this.provider === 'gemini' ? cfg().geminiModel : cfg().model;
  },
  /**
   * Who is answering, in the words the app puts on screen.
   *
   * Every AI surface used to be labelled "Claude" in the markup, so with
   * Gemini chosen the app said Claude while Google answered — and there was
   * no way at all to tell which engine had written what you were reading.
   * One getter, so a new engine cannot be added and left half-named again.
   */
  get engine() {
    return this.isLive ? this.providerLabel : 'Built-in tutor';
  },
  /** The same, with the exact model — for a tooltip or a status line. */
  get engineDetail() {
    return this.isLive
      ? `${this.providerLabel} · ${this.model}`
      : 'Answering from the dictionary on this device';
  },

  url(route) {
    return `${proxyBase()}${route}`;
  },

  /** Is the proxy reachable? Returns a short human-readable status string. */
  async health() {
    if (!this.isLive) return 'Built-in tutor — answers come from the dictionary on this device.';
    try {
      const res = await fetch(this.url(AI.routes.health), { signal: timeout(6000) });
      /* A 404 is the one status that is not a server problem: something
         answered, and it was not the proxy. Almost always the address is
         right but nothing is deployed at it yet — "check the server logs"
         sends someone looking for a server that is not running. */
      if (res.status === 404) {
        const at = proxyBase() || location.origin;
        return `No proxy at ${at} — that address answered, but it has no /api routes. `
          + 'Deploy the proxy there, or point this at where it is running.';
      }
      if (!res.ok) return `Proxy responded ${res.status}. Check the server logs.`;
      const body = await res.json();
      const info = body.providers?.[this.provider];
      const name = PROVIDERS[this.provider]?.label || this.provider;
      if (!info) return `Proxy is up, but it does not offer ${name}.`;
      return info.ready
        ? `Connected — ${name} ready on ${info.model}.`
        : `Proxy is up but has no key for ${name}.`;
    } catch (err) {
      // The same sentence the learner would have got mid-question, said here
      // instead — where there is something they can do about it.
      return `Cannot use ${PROVIDERS[this.provider]?.label || this.provider}: ${diagnose(err)}`;
    }
  },

  // ── JSON calls ───────────────────────────────────────────────────────────

  /** Full dictionary entry for a word: definition, examples, mnemonic… */
  async enrichWord(term, opts = {}) {
    if (!this.isLive) return localWord(term, opts.level);
    return post(this.url(AI.routes.word), { term, level: opts.level, model: this.model, provider: this.provider });
  },

  /** A multiple-choice item for `word`, with plausible distractors. */
  async quiz(word, pool, opts = {}) {
    if (!this.isLive) return localQuiz(word, pool);
    return post(this.url(AI.routes.quiz), {
      term: word.term,
      definition: word.definition,
      distractors: pool.map((w) => w.term).slice(0, 8),
      level: opts.level,
      model: this.model,
      provider: this.provider,
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
      model: this.model,
      provider: this.provider,
    });
  },

  // ── streaming calls ──────────────────────────────────────────────────────

  /**
   * One explanation of a word — meaning, usage, memory hook. Streams so the
   * panel fills in the same way whichever half is answering.
   */
  /** An explanation of `word` from the device, for the same reason. */
  async offlineExplain(word, onToken, opts = {}) {
    return replay(localExplain(word, opts.level), onToken);
  },

  async explain(word, onToken, opts = {}) {
    if (!this.isLive) return replay(localExplain(word, opts.level), onToken);
    return stream(this.url(AI.routes.coach), {
      term: word.term,
      definition: word.definition,
      level: opts.level,
      sentence: `Explain "${word.term}" to a ${opts.level || 'B1'} learner: two short sentences of plain English, one natural example sentence, then one memory hook.`,
      model: this.model,
      provider: this.provider,
    }, onToken);
  },

  /** Feedback on a learner-written sentence. Streams tokens to `onToken`. */
  async coach({ term, definition, sentence, level }, onToken) {
    if (!this.isLive) return replay(localCoach(term, sentence), onToken);
    return stream(this.url(AI.routes.coach),
      { term, definition, sentence, level, model: this.model, provider: this.provider }, onToken);
  },

  /**
   * An open question from the learner, with the conversation so far.
   *
   * Offline this answers from the dictionary where the question is about a
   * word, and says plainly when it cannot rather than guessing.
   */
  async ask({ question, history = [], level }, onToken) {
    if (!this.isLive) return this.offlineAnswer(question, onToken);
    return stream(this.url(AI.routes.ask),
      { question, history, level, model: this.model, provider: this.provider }, onToken);
  },

  /**
   * The same question, answered from the dictionary on the device.
   *
   * Kept reachable on its own so a surface whose live call could not leave the
   * browser can still put an answer on screen. A red line and nothing else is
   * the worst outcome available: the app ships 117,000 words and can very
   * often answer the question itself.
   */
  async offlineAnswer(question, onToken) {
    const answer = await localAnswer(question).catch(() => null);
    return replay(answer || OFFLINE_MISS, onToken);
  },

  /**
   * The capability read-out after a placement exam. The plan itself is computed
   * in advice.js and passed in — Claude explains it, it does not invent it, so
   * the recommendation is the same whichever half is answering.
   */
  async assess(payload, onToken) {
    if (!this.isLive) return replay(localAssess(payload), onToken);
    return stream(this.url(AI.routes.assess), { ...payload, model: this.model, provider: this.provider }, onToken);
  },

  /**
   * A turn of the assistant with the app's actions available.
   *
   * Gemini only: this is function calling, and the built-in tutor has no
   * concept of it. The caller runs whatever comes back, or does not — nothing
   * here touches the learner's state.
   */
  async act({ question, system, history = [], tools = [], results = [] }) {
    if (!this.isLive) return { text: '', calls: [], offline: true };
    const route = results.length ? '/api/act/result' : '/api/act';
    const res = await fetch(this.url(route), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question, system, history, tools, results,
        model: this.model, provider: this.provider,
      }),
      signal: timeout(),
    });
    const out = await res.json();
    if (!out?.ok) throw new Error(out?.error || 'The assistant could not be reached.');
    return out;
  },

  /** Weekly progress write-up from the tracking snapshot. */
  async report(payload, onToken) {
    if (!this.isLive) return replay(localReport(payload), onToken);
    return stream(this.url(AI.routes.report), { stats: payload, model: this.model, provider: this.provider }, onToken);
  },
};

// ── transport ──────────────────────────────────────────────────────────────

function timeout(ms = AI.timeoutMs) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

/**
 * A stream is given up on for going quiet, not for taking a while.
 *
 * `AbortSignal.timeout` covers the whole response, body included, so an answer
 * that was streaming perfectly well was cut off the moment it passed the
 * limit — and a browser reports that as "BodyStreamBuffer was aborted", which
 * names neither the cause nor a fix and was shown to the learner verbatim.
 * What is actually worth giving up on is silence: no bytes at all for this
 * long means nothing more is coming. So the clock is reset by every chunk,
 * and a long answer can take as long as it needs.
 */
function stall(ms = AI.stallMs) {
  const ctrl = new AbortController();
  let timer = null;
  const clock = {
    signal: ctrl.signal,
    stalled: false,
    /* Not `abort(reason)`: the reason surfaces differently across browsers,
       and this flag is read by the one place that cares. */
    bump() {
      clearTimeout(timer);
      timer = setTimeout(() => { clock.stalled = true; ctrl.abort(); }, ms);
    },
    stop() { clearTimeout(timer); },
  };
  clock.bump();
  return clock;
}

const sec = (ms) => {
  const n = Math.max(1, Math.round(ms / 1000));
  return `${n} second${n === 1 ? '' : 's'}`;
};

/* Only ever said when nothing at all arrived: a stall that interrupts an
   answer already in progress keeps what it has rather than reporting. */
const silence = () =>
  `it took the question and then sent nothing for ${sec(AI.stallMs)}.`;

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

/**
 * Why the request never left, in words that name the fix.
 *
 * A browser reports every one of these as the same `TypeError: Failed to
 * fetch` — wrong scheme, wrong host, server down, origin not allowed. The app
 * knows which page it is on and which address it was given, so it can nearly
 * always tell them apart; showing the browser's own sentence instead left
 * someone on a deployed site staring at "Failed to fetch" with no idea that
 * the address still pointed at their own laptop.
 */
export function diagnose(err, endpoint = proxyBase()) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `the server did not answer within ${sec(AI.timeoutMs)}.`;
  }
  // A real HTTP answer — the server was reached, so it speaks for itself.
  if (!/Failed to fetch|NetworkError|Load failed/i.test(err?.message || '')) return err?.message || String(err);

  // Empty is same-origin, which is a real answer, not a missing one.
  if (!endpoint.trim()) return 'this app has no AI server set for it.';

  let url;
  try { url = new URL(endpoint); } catch {
    return `"${endpoint}" is not a valid server address for this build.`;
  }

  const pageIsHttps = typeof location !== 'undefined' && location.protocol === 'https:';
  const pageIsLocal = typeof location !== 'undefined' && LOCAL_HOST.test(location.hostname);
  const serverIsLocal = LOCAL_HOST.test(url.hostname);

  /* The one that actually bites: the app is published, the address still says
     localhost. It works on the machine running the proxy and nowhere else, so
     it looks fine to whoever set it up and is broken for everybody. */
  if (serverIsLocal && !pageIsLocal) {
    return `the address is ${url.host}, which means "this computer" — so a page served from `
      + `${location.host} cannot reach it. If this site is serving the proxy too, empty the `
      + 'address box in Settings → AI help. Otherwise host the proxy in vocab/server somewhere '
      + 'public and put that address there.';
  }
  if (pageIsHttps && url.protocol === 'http:') {
    return `this page is on https and the server address is http, which browsers block. `
      + `Use https://${url.host} instead.`;
  }
  return `${url.host} did not answer. Check the proxy is running, and that ALLOWED_ORIGIN there `
    + `is ${typeof location !== 'undefined' ? location.origin : 'this app\'s origin'}.`;
}

async function post(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeout(),
    });
  } catch (err) { throw new Error(diagnose(err)); }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `AI request failed (${res.status})`);
  }
  return payload.data;
}

/** Reads an SSE body, calling `onToken` per delta; resolves with the full text. */
async function stream(url, body, onToken) {
  const clock = stall();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: clock.signal,
    });
  } catch (err) {
    clock.stop();
    throw new Error(clock.stalled ? silence() : diagnose(err));
  }
  if (!res.ok || !res.body) {
    clock.stop();
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `AI request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  /* The read loop was not guarded before. An abort here is a rejection like
     any other, and it escaped as whatever the browser called it — which is
     how "BodyStreamBuffer was aborted" reached the screen with the app's own
     diagnosis sitting unused a few lines above. */
  try {
    while (true) {
      const { done, value } = await reader.read();
      clock.bump();
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
  } catch (err) {
    /* Whatever arrived before the break is still an answer, and throwing it
       away to show an error is a worse trade than showing both. */
    if (clock.stalled && full) return full;
    throw new Error(clock.stalled ? silence() : diagnose(err));
  } finally {
    clock.stop();
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
