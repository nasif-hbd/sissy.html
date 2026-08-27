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

export const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
export const hasGeminiKey = () => Boolean(geminiKey());

/**
 * Model ids move faster than this file will. The default is the cheapest tier
 * Google publishes; override with GEMINI_MODEL if it has been renamed.
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';

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

async function call(path, payload, model) {
  const res = await fetch(`${BASE}/${model}:${path}&key=${encodeURIComponent(geminiKey())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // The key is in the URL, so an error echoing it back must never be logged
    // or forwarded verbatim.
    throw new Error(`Gemini responded ${res.status}. ${scrub(detail).slice(0, 200)}`);
  }
  return res;
}

const scrub = (text) => String(text).replace(/key=[\w-]+/gi, 'key=…');

/**
 * One structured-output request.
 *
 * Gemini enforces a schema through `responseSchema`, but rejects the
 * JSON-Schema keywords it does not implement — `additionalProperties` among
 * them — so the schema is trimmed before it is sent.
 */
export async function geminiJson(prompt, schema, model = GEMINI_MODEL) {
  const res = await call('generateContent?', body(prompt, {
    responseMimeType: 'application/json',
    responseSchema: forGemini(schema),
  }), model);

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
export async function geminiStream(prompt, onToken, model = GEMINI_MODEL) {
  const res = await call('streamGenerateContent?alt=sse', body(prompt), model);
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
      const text = evt?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      if (text) { full += text; onToken(text); }
    }
  }
  return full;
}
