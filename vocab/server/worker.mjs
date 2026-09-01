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

/**
 * Find a binding, forgivingly.
 *
 * Cloudflare's binding names are case-sensitive and typed by hand into a web
 * form, so `Gemini_API_Key` and a trailing space both produce a Worker that
 * looks configured and behaves as though it is not. The exact name is tried
 * first; only then a case-insensitive, space-trimmed match, and the aliases
 * for the same key under another provider's name.
 */
function binding(env, ...names) {
  for (const name of names) {
    if (env[name]) return String(env[name]).trim();
  }
  const wanted = names.map((n) => n.toLowerCase());
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (wanted.includes(key.trim().toLowerCase())) return value.trim();
  }
  return '';
}

const geminiKeyOf = (env) => binding(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
const claudeKeyOf = (env) => binding(env, 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY');

/**
 * Compare two tokens without letting the clock describe the difference.
 *
 * A plain === returns on the first byte that differs, so the time it takes
 * tells an attacker how much of their guess was right. This looks at every
 * byte whatever happens.
 */
function sameToken(given, expected) {
  const a = String(given), b = String(expected);
  if (!b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * The feedback inbox, over whichever kind of storage was bound.
 *
 * Cloudflare offers KV and D1 side by side in the same "Add binding" menu,
 * and the two are easy to pick the wrong one of — they take the same variable
 * name and give no hint that the code cares. Rather than make that a mistake
 * someone has to diagnose, both work: a binding with `put` is KV, one with
 * `prepare` is D1, and everything above this line is written once.
 */
function inboxOf(env) {
  const kv = env.FEEDBACK;
  if (!kv) return null;

  if (typeof kv.put === 'function') {
    return {
      kind: 'KV',
      async save(key, note) { await kv.put(key, JSON.stringify(note)); },
      async all() {
        const list = await kv.list({ prefix: 'fb:', limit: 200 });
        const rows = await Promise.all(list.keys.map(async ({ name }) => {
          try { return JSON.parse(await kv.get(name)); } catch { return null; }
        }));
        return rows.filter(Boolean);
      },
    };
  }

  if (typeof kv.prepare === 'function') {
    /* One table, made on demand: nobody should have to run a migration by
       hand to receive a bug report. The note is stored as the same JSON KV
       holds, so the two are the same shape when they come back out. */
    const ready = kv.prepare(
      'CREATE TABLE IF NOT EXISTS feedback (key TEXT PRIMARY KEY, at TEXT, note TEXT)').run();
    return {
      kind: 'D1',
      async save(key, note) {
        await ready;
        await kv.prepare('INSERT INTO feedback (key, at, note) VALUES (?, ?, ?)')
          .bind(key, note.at, JSON.stringify(note)).run();
      },
      async all() {
        await ready;
        const out = await kv.prepare(
          'SELECT note FROM feedback ORDER BY at DESC LIMIT 200').all();
        return (out.results || []).map((r) => {
          try { return JSON.parse(r.note); } catch { return null; }
        }).filter(Boolean);
      },
    };
  }

  return null;
}

/**
 * The names of everything bound to this Worker — never the values.
 *
 * A key typed into the wrong field, the wrong environment or the wrong Worker
 * all present identically: "no key set". Listing what actually arrived turns
 * an afternoon of guessing into one glance.
 */
function bindingNames(env) {
  return Object.keys(env)
    .filter((k) => typeof env[k] === 'string')
    .sort();
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
  if (want === 'gemini' && !geminiKeyOf(env)) {
    throw new HttpError(503, 'This proxy has no GEMINI_API_KEY set. '
      + `It can see: ${bindingNames(env).join(', ') || 'nothing at all'}.`);
  }
  if (want === 'anthropic' && !claudeKeyOf(env)) {
    throw new HttpError(503, 'This proxy has no ANTHROPIC_API_KEY set. '
      + `It can see: ${bindingNames(env).join(', ') || 'nothing at all'}.`);
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
      'x-api-key': claudeKeyOf(env),
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
  /**
   * The root path, which is the one a person actually opens.
   *
   * Cloudflare's editor previews a Worker at "/", and every host's health
   * check hits it too — so a bare 404 here reads as "the deploy failed" at
   * exactly the moment someone is checking whether it worked. It says what
   * this is, whether it has its keys, and where to look next.
   */
  'GET /': (body, env) => ({
    ok: true,
    service: 'VocabX AI proxy',
    ready: Boolean(geminiKeyOf(env) || claudeKeyOf(env)),
    engines: {
      gemini: geminiKeyOf(env) ? 'key set' : 'no GEMINI_API_KEY',
      claude: claudeKeyOf(env) ? 'key set' : 'no ANTHROPIC_API_KEY',
    },
    // Unset means this Worker answers any site that finds it, and they spend
    // your credit. Worth seeing at a glance rather than only in the docs.
    allowedOrigin: binding(env, 'ALLOWED_ORIGIN') || 'NOT SET — this Worker answers any website',
    sees: bindingNames(env),
    next: 'Full status at /api/health. Put this Worker\'s address into the app: Settings → AI help → Your server.',
  }),

  'GET /api/health': (body, env) => ({
    ok: true,
    hasKey: Boolean(claudeKeyOf(env)),
    model: CLAUDE_MODEL,
    push: false,
    runtime: 'cloudflare-worker',
    providers: {
      anthropic: { ready: Boolean(claudeKeyOf(env)), model: CLAUDE_MODEL },
      gemini: { ready: hasGeminiKey(), model: geminiDefaultModel() },
    },
    /* Names only, never values. A key in the wrong field, the wrong
       environment or the wrong Worker all look identical from outside —
       "no key set" — and this is what tells them apart. */
    sees: bindingNames(env),
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

  /**
   * Feedback.
   *
   * Stored in a KV namespace bound as FEEDBACK. Without that binding there is
   * nowhere to put it, and the honest answer is to say so rather than to
   * accept the note and drop it — the app then keeps it on the device and
   * offers the reader their own mail client, which does reach someone.
   *
   * An anonymous report is stored exactly as it arrived. Nothing is added on
   * this side either: no IP, no country, no user agent. A promise made in the
   * interface that the server quietly broke would be worse than no promise.
   */
  'POST /api/feedback': async (body, env) => {
    const text = String(body.text || '').trim().slice(0, 4000);
    if (!text) throw new HttpError(400, 'Nothing was written.');
    const inbox = inboxOf(env);
    if (!inbox) {
      throw new HttpError(503, 'This proxy has no feedback inbox. '
        + 'Bind a KV namespace (or a D1 database) called FEEDBACK to it, '
        + 'or use the email option.');
    }

    const anonymous = body.anonymous === true;
    const note = {
      at: new Date().toISOString(),
      anonymous,
      kind: String(body.kind || 'idea').slice(0, 20),
      mood: String(body.mood || '').slice(0, 20),
      text,
      // Only ever from a report that says it is not anonymous.
      from: anonymous ? '' : String(body.from || '').trim().slice(0, 200),
      context: anonymous ? null : body.context || null,
    };

    /* Keyed by time so a listing comes back newest first, and by a random
       suffix so two notes in the same millisecond cannot overwrite each
       other — which, for anonymous feedback, would lose one silently. */
    const key = `fb:${Date.now().toString().padStart(14, '0')}:${crypto.randomUUID().slice(0, 8)}`;
    await inbox.save(key, note);
    return { ok: true, data: { stored: true, in: inbox.kind } };
  },

  /**
   * Reading it back.
   *
   * Off unless FEEDBACK_TOKEN is set, so a proxy nobody has locked cannot
   * hand its inbox to whoever asks. The token is compared in full length to
   * keep the comparison from leaking its prefix through timing.
   */
  'POST /api/feedback/list': async (body, env) => {
    const inbox = inboxOf(env);
    if (!inbox) throw new HttpError(503, 'No feedback inbox is bound.');
    if (!env.FEEDBACK_TOKEN) throw new HttpError(403, 'Reading is off: no FEEDBACK_TOKEN is set.');
    if (!sameToken(String(body.token || ''), env.FEEDBACK_TOKEN)) {
      throw new HttpError(401, 'Wrong token.');
    }
    const notes = await inbox.all();
    /* Sorted on what each note says its time is, rather than trusting the
       order the keys came back in: KV guarantees its listing is sorted by
       key, and two notes written in one millisecond differ only by the random
       suffix that stops them overwriting each other. */
    return {
      ok: true,
      data: notes.sort((a, b) => String(b.at).localeCompare(String(a.at))),
    };
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
    configureGemini({ apiKey: geminiKeyOf(env), model: binding(env, 'GEMINI_MODEL') });

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
