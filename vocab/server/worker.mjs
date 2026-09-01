/**
 * The same AI proxy, as a Cloudflare Worker.
 *
 * Why a second entry point rather than a second implementation: `proxy.mjs`
 * needs Node — an http server, the filesystem, a TCP socket for SMTP — and a
 * Worker has none of those. But the AI routes need only `fetch`, which is the
 * one thing both runtimes agree on, so the prompts, the schemas and the whole
 * Gemini client are shared with the Node proxy rather than copied. Edit a
 * prompt once and both change.
 *
 * What this does NOT carry, because a Worker cannot: serving the app's files
 * (a static host does that), web push, and emailed feedback (SMTP is a raw
 * socket). Feedback still reaches you — the app falls back to opening a mail
 * draft — and reminders still fire locally while a tab is open.
 *
 *   npx wrangler deploy            or paste dist/worker.js into the dashboard
 *
 * Secrets: GEMINI_API_KEY and/or ANTHROPIC_API_KEY.
 * Vars:    ALLOWED_ORIGIN — the exact origin of your app. Set it. Without it
 *          the Worker answers anyone, and anyone can spend your API credit.
 */
import {
  wordPrompt, wordSchema, quizPrompt, quizSchema,
  suggestPrompt, suggestSchema, coachPrompt, reportPrompt, assessPrompt, askPrompt,
} from './prompts.mjs';
import { geminiJson, geminiStream, configure as configureGemini,
         geminiDefaultModel, hasGeminiKey } from './gemini.mjs';

const CLAUDE_MODEL = 'claude-haiku-4-5';
const CLAUDE_MODELS = new Set([CLAUDE_MODEL, 'claude-sonnet-5', 'claude-opus-5']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── engines ────────────────────────────────────────────────────────────────

/**
 * Which engine answers, and a clear refusal when it cannot.
 *
 * A client set to Gemini against a Claude-only Worker gets told exactly that,
 * rather than a generic failure it cannot act on.
 */
function provider(body, env) {
  const want = body?.provider === 'gemini' ? 'gemini' : 'anthropic';
  if (want === 'gemini' && !env.GEMINI_API_KEY) {
    throw new HttpError(503, 'This proxy has no GEMINI_API_KEY set.');
  }
  if (want === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, 'This proxy has no ANTHROPIC_API_KEY set.');
  }
  return want;
}

/** Only a model from the known-good list; anything else is the default. */
const claudeModel = (asked) => (CLAUDE_MODELS.has(asked) ? asked : CLAUDE_MODEL);

/** Raw fetch rather than the SDK: two calls, and the SDK is Node-shaped. */
async function claude({ system, user, messages }, env, model, stream = false) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: claudeModel(model),
      max_tokens: 2000,
      stream,
      ...(system ? { system } : {}),
      messages: messages?.length ? messages : [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new HttpError(res.status === 401 ? 401 : 502,
      `Claude responded ${res.status}. ${detail.slice(0, 200)}`);
  }
  return res;
}

/** Structured output from whichever engine was named. */
async function askJson(who, prompt, schema, body, env) {
  if (who === 'gemini') return geminiJson(prompt, schema, body?.model);

  /* Claude has no responseSchema, so the shape is asked for in words and the
     reply is parsed. A model that wraps JSON in prose is the usual failure,
     hence the braces hunt rather than a bare JSON.parse. */
  const res = await claude({
    ...prompt,
    user: `${prompt.user}\n\nReply with JSON only, matching this schema:\n${JSON.stringify(schema)}`,
  }, env, body?.model);
  const data = await res.json();
  const text = data?.content?.map((c) => c.text || '').join('') || '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new HttpError(502, 'Claude returned no JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Streamed text, as our own small SSE envelope.
 *
 * The app reads `{type:"text_delta"|"done"|"error"}` frames, so both engines
 * are translated into that rather than the browser learning two wire formats.
 */
function streamSse(who, prompt, body, env) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (payload) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        if (who === 'gemini') {
          await geminiStream(prompt, (text) => send({ type: 'text_delta', text }), body?.model);
        } else {
          const res = await claude(prompt, env, body?.model, true);
          await readAnthropicSse(res, (text) => send({ type: 'text_delta', text }));
        }
        send({ type: 'done' });
      } catch (err) {
        send({ type: 'error', error: err.message });
      }
      controller.close();
    },
  });
}

/** Anthropic's SSE → our text deltas. Frames are CRLF- or LF-separated. */
async function readAnthropicSse(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (frame) => {
    const line = frame.split(/\r?\n/).find((l) => l.startsWith('data:'));
    if (!line) return;
    let evt;
    try { evt = JSON.parse(line.slice(5).trim()); } catch { return; }
    if (evt.type === 'content_block_delta' && evt.delta?.text) onToken(evt.delta.text);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) take(frame);
  }
  if (buffer.trim()) take(buffer);
}

// ── routes ─────────────────────────────────────────────────────────────────

const routes = {
  'GET /api/health': (body, env) => ({
    ok: true,
    hasKey: Boolean(env.ANTHROPIC_API_KEY),
    model: CLAUDE_MODEL,
    push: false,
    runtime: 'cloudflare-worker',
    providers: {
      anthropic: { ready: Boolean(env.ANTHROPIC_API_KEY), model: CLAUDE_MODEL },
      gemini: { ready: hasGeminiKey(), model: geminiDefaultModel() },
    },
  }),

  'POST /api/ai/word': async (body, env) => {
    const who = provider(body, env);
    const term = String(body.term || '').trim().slice(0, 60);
    if (!term) throw new HttpError(400, 'No term given.');
    return { ok: true, data: await askJson(who, wordPrompt({ term, level: body.level }), wordSchema, body, env) };
  },

  'POST /api/ai/quiz': async (body, env) => {
    const who = provider(body, env);
    if (!body.term) throw new HttpError(400, 'No term given.');
    const data = await askJson(who, quizPrompt(body), quizSchema, body, env);
    // The schema cannot express "answerIndex is within options".
    if (!Array.isArray(data.options) || data.options.length < 2) {
      throw new HttpError(502, 'Model returned an unusable question.');
    }
    data.answerIndex = Math.max(0, Math.min(data.options.length - 1, data.answerIndex | 0));
    return { ok: true, data };
  },

  'POST /api/ai/suggest': async (body, env) => {
    const who = provider(body, env);
    const data = await askJson(who, suggestPrompt(body), suggestSchema, body, env);
    return { ok: true, data: data.words.slice(0, Number(body.count) || 6) };
  },

  'POST /api/ai/coach': (body, env) => {
    const who = provider(body, env);
    if (!body.sentence) throw new HttpError(400, 'No sentence given.');
    return streamSse(who, coachPrompt(body), body, env);
  },

  'POST /api/ai/ask': (body, env) => {
    const who = provider(body, env);
    const question = String(body.question || '').trim().slice(0, 1000);
    if (!question) throw new HttpError(400, 'No question given.');
    return streamSse(who, askPrompt({
      question,
      history: Array.isArray(body.history) ? body.history.slice(-12) : [],
      level: body.level,
    }), body, env);
  },

  'POST /api/ai/assess': (body, env) => {
    const who = provider(body, env);
    if (!body.estimate) throw new HttpError(400, 'No placement result given.');
    return streamSse(who, assessPrompt({
      estimate: body.estimate, plan: body.plan || null, deck: body.deck || {},
    }), body, env);
  },

  'POST /api/ai/report': (body, env) => {
    const who = provider(body, env);
    return streamSse(who, reportPrompt({ stats: body.stats || {}, level: body.stats?.level }), body, env);
  },

  /** Translation, same envelope. No key needed for this endpoint. */
  'POST /api/translate': async (body) => {
    const text = String(body.text || '').slice(0, 400);
    const to = String(body.to || '').slice(0, 8);
    if (!text || !to) throw new HttpError(400, 'Need text and a target language.');
    const url = 'https://translate.googleapis.com/translate_a/single'
      + `?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new HttpError(502, `Translation service responded ${res.status}.`);
    const data = await res.json();
    return { ok: true, data: { text: (data?.[0] || []).map((p) => p?.[0] || '').join('') } };
  },
};

// ── the Worker ─────────────────────────────────────────────────────────────

/**
 * CORS.
 *
 * ALLOWED_ORIGIN unset means `*`, which is right for a scratch deployment and
 * wrong for a real one: it lets any page on the internet spend your API
 * credit. The health route says which you have.
 */
function cors(env) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const headers = cors(env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    // The Gemini client reads its key from here rather than from process.env,
    // which a Worker does not have.
    configureGemini({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });

    const url = new URL(request.url);
    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) {
      return Response.json({ ok: false, error: 'Not found.' }, { status: 404, headers });
    }

    try {
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      const out = await handler(body, env);
      // A stream is an answer being written; anything else is one JSON reply.
      if (out instanceof ReadableStream) {
        return new Response(out, {
          headers: { ...headers, 'content-type': 'text/event-stream; charset=utf-8',
                     'cache-control': 'no-cache, no-transform' },
        });
      }
      return Response.json(out, { headers });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return Response.json({ ok: false, error: err.message }, { status, headers });
    }
  },
};
