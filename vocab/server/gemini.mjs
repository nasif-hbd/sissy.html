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
export function configure({ apiKey, model } = {}) {
  injected = { apiKey: apiKey || '', model: model || '' };
}
const fromEnv = (name) => (typeof process !== 'undefined' ? process.env?.[name] : '') || '';

export const geminiKey = () =>
  injected?.apiKey || fromEnv('GEMINI_API_KEY') || fromEnv('GOOGLE_API_KEY');
export const hasGeminiKey = () => Boolean(geminiKey());

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
async function call(path, payload, model, attempt = 0) {
  const res = await fetch(`${BASE}/${model}:${path}&key=${encodeURIComponent(geminiKey())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) return res;

  const detail = await res.text().catch(() => '');
  if ((res.status === 503 || res.status === 429) && attempt === 0) {
    await new Promise((done) => setTimeout(done, 1200));
    return call(path, payload, model, attempt + 1);
  }
  // The key is in the URL, so an error echoing it back must never be logged
  // or forwarded verbatim.
  throw new Error(`${reason(res.status)} ${scrub(detail).slice(0, 200)}`);
}

/** What the status actually means to someone using the app. */
function reason(status) {
  if (status === 404) return 'Gemini has no such model (404) — the id may have been retired.';
  if (status === 400) return 'Gemini rejected the request (400).';
  if (status === 401 || status === 403) return 'Gemini rejected the key (' + status + ').';
  if (status === 429) return 'Gemini is rate-limiting this key (429).';
  if (status === 503) return 'Gemini is overloaded right now (503).';
  return `Gemini responded ${status}.`;
}

const scrub = (text) => String(text).replace(/key=[\w-]+/gi, 'key=…');

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
