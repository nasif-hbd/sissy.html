/**
 * Google Gemini, as an alternative to Claude behind the same routes.
 *
 * Raw REST rather than a package: the two calls this app makes are a JSON
 * request and an SSE stream, and adding a dependency for that would be a worse
 * trade than thirty lines of fetch.
 *
 * The key lives here, never in the browser — the same rule the Anthropic path
 * follows. A key shipped to the browser is a key anyone who opens the app can
 * read and spend.
 */
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/*
 * Where the key and the model come from.
 *
 * Under Node they are environment variables. A Cloudflare Worker has no
 * `process.env` — its secrets arrive as a per-request `env` object — so
 * `configure()` lets the Worker hand them over at the top of a request
 * without every function in this file growing a parameter.
 */
let injected = null;
export function configure({ apiKey, apiKeys, model } = {}) {
  injected = { apiKey: apiKey || '', apiKeys: apiKeys || '', model: model || '' };
}
const fromEnv = (name) => (typeof process !== 'undefined' ? process.env?.[name] : '') || '';

/**
 * Every key this deployment has, in order.
 *
 * Gemini's free tier is metered per key, so ten keys is ten times the daily
 * quota — which is the whole reason this is a list rather than a string. They
 * can be given as one variable holding several (comma or newline separated),
 * or as GEMINI_API_KEY, GEMINI_API_KEY_2 … _10; both because the Cloudflare
 * dashboard makes the second easy and a config file makes the first easy.
 *
 * Duplicates are dropped. Two entries of the same key look like redundancy
 * and are not: when it is exhausted, both fail, and the second attempt is a
 * wasted round trip on every request for the rest of the day.
 */
export function geminiKeys() {
  const pooled = String(injected?.apiKeys || fromEnv('GEMINI_API_KEYS') || '');
  const numbered = [];
  for (let n = 2; n <= 10; n += 1) numbered.push(fromEnv(`GEMINI_API_KEY_${n}`));

  const all = [
    injected?.apiKey || '',
    ...pooled.split(/[,\n\r\s]+/),
    fromEnv('GEMINI_API_KEY'),
    fromEnv('GOOGLE_API_KEY'),
    ...numbered,
  ].map((k) => k.trim()).filter(Boolean);

  return [...new Set(all)];
}

/** The first key, for the places that only need to know whether one exists. */
export const geminiKey = () => geminiKeys()[0] || '';
export const hasGeminiKey = () => geminiKeys().length > 0;
/** How many are configured. Never the values — only ever the count. */
export const geminiKeyCount = () => geminiKeys().length;

/**
 * Model ids move faster than this file will, and a retired one answers 404 —
 * which is why the default is one of Google's floating aliases rather than a
 * pinned version. Override with GEMINI_MODEL to pin.
 *
 * ListModels is not a reliable guide to what a key may call: it advertises
 * models that answer 404 on generateContent for the same key, so a new id
 * belongs here only once it has actually been called.
 */
export const DEFAULT_MODEL = 'gemini-flash-lite-latest';
/** A getter, not a constant: a Worker learns its model after this file loads. */
export const geminiDefaultModel = () =>
  injected?.model || fromEnv('GEMINI_MODEL') || DEFAULT_MODEL;
/** Kept for the Node proxy, which reads it once at startup to print it. */
export const GEMINI_MODEL = fromEnv('GEMINI_MODEL') || DEFAULT_MODEL;

/**
 * The model to actually call.
 *
 * A client that names a model belonging to another engine — "claude-haiku-4-5"
 * reached here for months, because the browser sent one `model` field whichever
 * engine was chosen — must not turn into a 404 from Google. Anything that is
 * not a Gemini id falls back to the configured default.
 */
export function geminiModel(asked) {
  return /^(gemini|gemma)[\w.-]*$/i.test(String(asked || '')) ? asked : geminiDefaultModel();
}

/** Our history shape → Gemini's. It calls the assistant turn "model". */
const toContents = (messages) => messages.map((m) => ({
  role: m.role === 'assistant' ? 'model' : 'user',
  parts: [{ text: String(m.content ?? '') }],
}));

function body({ system, user, messages }, extra = {}) {
  const contents = messages?.length
    ? toContents(messages)
    : [{ role: 'user', parts: [{ text: user }] }];
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { temperature: 0.6, maxOutputTokens: 2000, ...extra },
  };
}

/**
 * One request, with a single retry on the two statuses that mean "ask again"
 * rather than "you asked wrong": 503 is Gemini's model-overloaded, and 429 is
 * a rate limit. Both clear on a retry more often than not, and a learner
 * waiting on a hint should not be shown an error for either.
 */
/**
 * Which failures mean "this key is done" rather than "ask again".
 *
 * The distinction is the whole feature. Rotating on the wrong status burns
 * all ten keys on a single malformed request and leaves nothing for the rest
 * of the day; rotating on too few leaves nine keys idle while the first sits
 * at its quota. So:
 *
 *   429  quota or rate limit — on the free tier this is usually the daily
 *        cap, and the next key has its own.
 *   403  key disabled, restricted, or the API not enabled on that project.
 *   400  only when the body says API_KEY_INVALID. A plain 400 is a bad
 *        request, and every other key will reject it identically.
 *
 * Not 503: that is the model being busy, not the key, and the backoff below
 * handles it. Not 404: a retired model id fails the same way everywhere.
 */
function keyIsSpent(status, detail) {
  if (status === 429 || status === 403) return true;
  return status === 400 && /API_KEY_INVALID|API key not valid/i.test(detail);
}

/* Where the next request starts. Kept across calls so ten keys share the load
   rather than the first carrying everything until it is exhausted, and moved
   to whichever key last worked so a healthy one is tried first. */
let cursor = 0;

/*
 * How long one key gets, and how long the whole walk gets.
 *
 * Both are needed, and the second is why this exists at all. A key whose
 * request hangs would otherwise hold the walk open with nothing to show for
 * it; and ten keys that each fail slowly add up past what the browser is
 * willing to wait, which reaches the learner as an aborted stream — a browser
 * sentence naming neither a cause nor a fix — instead of an error anyone can
 * read. The walk budget is deliberately under the client's own limit, so on a
 * bad day the last word is ours.
 */
const ATTEMPT_MS = 12_000;
const WALK_MS = 25_000;
const RETRY_MS = 1_200;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * One request on one key, given its own time limit.
 *
 * The timer is cleared the moment the headers land, not when the body ends.
 * `fetch`'s signal covers the body too, so leaving it armed would cut a long
 * streamed answer off part-way — which is the exact failure this timeout is
 * here to prevent, moved one layer down.
 */
async function attempt(path, payload, model, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`no answer within ${ATTEMPT_MS / 1000}s`)), ATTEMPT_MS);
  try {
    return await fetch(`${BASE}/${model}:${path}&key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One key, plus the single retry a busy answer earns it.
 *
 * The retry stays on this key. It used to restart the whole walk, so one 503
 * partway down a list of ten keys turned a single question into twenty round
 * trips — comfortably longer than the browser waits, which is how a working
 * deployment ended up reporting a network error.
 *
 * Only 503 is retried. 429 is not: on the free tier it is usually the daily
 * cap, and waiting 1.2 seconds per key before moving on would spend twelve
 * seconds proving what the next key answers immediately.
 */
async function useKey(path, payload, model, key, deadline) {
  for (let go = 0; go < 2; go += 1) {
    let res;
    try {
      res = await attempt(path, payload, model, key);
    } catch (err) {
      /* Never answered. That is Google being unreachable rather than this key
         being finished, but the next key is worth one try — and the walk
         deadline stops this from becoming ten hangs in a row. */
      return { failed: { status: 0, detail: err?.message || 'no response' }, spent: true };
    }

    if (res.ok) return { res };

    // The key is in the URL, so nothing from this response is safe to keep
    // verbatim — and the key itself is never named in what is kept.
    const detail = await res.text().catch(() => '');

    if (go === 0 && res.status === 503 && Date.now() + RETRY_MS < deadline) {
      await pause(RETRY_MS);
      continue;
    }
    return { failed: { status: res.status, detail }, spent: keyIsSpent(res.status, detail) };
  }
}

/**
 * One request, across however many keys this deployment has.
 *
 * A spent key is stepped over immediately; anything that is not the key's
 * fault stops the walk, because every other key would answer it identically.
 */
async function call(path, payload, model) {
  const keys = geminiKeys();
  if (!keys.length) throw new Error('No Gemini key is configured on this deployment.');

  const start = cursor % keys.length;
  const deadline = Date.now() + WALK_MS;
  let last = null;

  for (let i = 0; i < keys.length; i += 1) {
    const at = (start + i) % keys.length;
    const out = await useKey(path, payload, model, keys[at], deadline);

    if (out.res) {
      // Stay on the key that worked rather than moving on every request.
      cursor = at;
      return out.res;
    }

    last = { ...out.failed, index: at };
    if (!out.spent) throw new Error(`${reason(last.status)} ${scrub(last.detail).slice(0, 200)}`);

    /* Out of time rather than out of keys, and worth separating: the answer to
       one is another key, the answer to the other is to wait. */
    if (Date.now() >= deadline && i + 1 < keys.length) {
      throw new Error(`Gemini did not answer within ${Math.round(WALK_MS / 1000)} seconds — `
        + `${i + 1} of ${keys.length} keys tried.`);
    }
  }

  /* Every key refused. On a free tier this is normal once a day and the
     message says so, because "Gemini rate-limited this key" reads like a bug
     when the real answer is "come back tomorrow, or add another key". */
  const spent = keys.length;
  const note = spent > 1
    ? `All ${spent} Gemini keys are exhausted or rejected.`
    : reason(last?.status ?? 429);
  throw new Error(`${note} ${scrub(last?.detail || '').slice(0, 200)}`);
}

function reason(status) {
  if (!status) return 'Gemini did not answer in time.';
  if (status === 404) return 'Gemini has no such model (404) — the id may have been retired.';
  if (status === 400) return 'Gemini rejected the request (400).';
  if (status === 401 || status === 403) return 'Gemini rejected the key (' + status + ').';
  if (status === 429) return 'Gemini is rate-limiting this key (429).';
  if (status === 503) return 'Gemini is overloaded right now (503).';
  return `Gemini responded ${status}.`;
}

/**
 * An error body, with anything key-shaped taken out of it.
 *
 * Stripping `key=` from the URL was the whole of this, which covered the one
 * place a key was known to appear and rested on Google never echoing it
 * anywhere else. That is an assumption, not a guarantee, and the string it
 * guards reaches the browser and is written into the chat log — where a
 * leaked key is spent by whoever reads it. So the configured keys are
 * redacted by value too. Short ones are left alone: a twelve-character
 * minimum keeps this from mangling ordinary prose, and a real Gemini key is
 * thirty-nine.
 */
function scrub(text) {
  let out = String(text).replace(/key=[\w-]+/gi, 'key=…');
  for (const key of geminiKeys()) {
    if (key.length >= 12) out = out.split(key).join('…');
  }
  return out;
}

/**
 * One structured-output request.
 *
 * Gemini enforces a schema through `responseSchema`, but rejects the
 * JSON-Schema keywords it does not implement — `additionalProperties` among
 * them — so the schema is trimmed before it is sent.
 */
export async function geminiJson(prompt, schema, model) {
  const res = await call('generateContent?', body(prompt, {
    responseMimeType: 'application/json',
    responseSchema: forGemini(schema),
  }), geminiModel(model));

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    const why = data?.promptFeedback?.blockReason;
    throw new Error(why ? `Gemini declined this request (${why}).` : 'Empty response from Gemini.');
  }
  return JSON.parse(text);
}

/** Strip the JSON-Schema keywords Gemini's subset rejects. */
export function forGemini(schema) {
  if (Array.isArray(schema)) return schema.map(forGemini);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema') continue;
    out[key] = forGemini(value);
  }
  return out;
}

/** Streaming request: every text delta is handed to `onToken`. */
export async function geminiStream(prompt, onToken, model) {
  const res = await call('streamGenerateContent?alt=sse', body(prompt), geminiModel(model));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const take = (frame) => {
    const line = frame.split(/\r?\n/).find((l) => l.startsWith('data:'));
    if (!line) return;
    let evt;
    try { evt = JSON.parse(line.slice(5).trim()); } catch { return; }
    const text = evt?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (text) { full += text; onToken(text); }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    /* Google separates frames with CRLF, not LF. Splitting on "\n\n" alone
       matched nothing at all — every frame stayed in the buffer and the whole
       answer was dropped on the floor, which is what made the tutor chat
       stream silence. */
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) take(frame);
  }
  // A stream that ends without a blank line after the last frame still has one
  // frame's worth of answer left in the buffer.
  if (buffer.trim()) take(buffer);
  return full;
}

/**
 * One turn with tools available.
 *
 * Gemini either answers in words or asks for one of the declared functions to
 * be run. It never runs anything itself — this returns the request, and the
 * caller decides whether to honour it. That split is deliberate: the model
 * lives on Google's servers and the learner's data lives on their phone, and
 * the only thing that crosses between them is the name of an action and its
 * arguments.
 *
 * `tools` is the list of function declarations; `history` carries earlier
 * turns, including the results of any calls already made, so a second round
 * can answer using what the first one found.
 */
export async function geminiAct({ system, user, history = [], tools = [] }, model) {
  const contents = history.length ? [...history] : [];
  if (user) contents.push({ role: 'user', parts: [{ text: user }] });

  const payload = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
    generationConfig: { temperature: 0.4, maxOutputTokens: 1200 },
  };

  const res = await call('generateContent?', payload, geminiModel(model));
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];

  /* A turn can hold several parts: some prose and a call, or two calls. The
     calls are what the caller must act on, so they come back as a list rather
     than as whichever one happened to be first. */
  const calls = parts.filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {} }));
  const text = parts.filter((p) => typeof p.text === 'string')
    .map((p) => p.text).join('').trim();

  return { text, calls, raw: json?.candidates?.[0]?.content || null };
}

/** A function's result, in the shape Gemini expects back in the next turn. */
export function toolResult(name, result) {
  return {
    role: 'user',
    parts: [{ functionResponse: { name, response: { result } } }],
  };
}
