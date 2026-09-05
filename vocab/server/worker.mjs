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
         geminiDefaultModel, hasGeminiKey, geminiAct, toolResult,
         geminiKeyCount } from './gemini.mjs';
import { storeOf, withinRate, ID, LIMITS } from './store.mjs';
import { accountsOf, cleanEmail, cleanName, isVerifier, isToken, matches,
         CLIENT_ROUNDS, MAX_TRIES } from './accounts.mjs';

/* Said in three places, and it has to be the same sentence each time: the app
   shows it verbatim and "no database" is a setup step, not a fault. */
const NO_ACCOUNTS = 'This deployment has no database, so it cannot hold accounts. '
  + 'Everything still works as a guest.';
const WRONG = 'That email and password do not match an account.';
/* A real stored value, for an account that does not exist — see the login
   route. Its own verifier is not a secret and could not be one: anyone can
   make an account and hash their own password. */
const DECOY = '00000000000000000000000000000000$'
  + '0000000000000000000000000000000000000000000000000000000000000000';
const NO_DB = 'No database is bound to this Worker.';
/* One sentence for a guest id that is malformed and for a session that has
   expired. They are the same thing from here — nothing names data this caller
   may read — and the app knows which of its two it sent. */
const NOT_YOU = 'This request does not name an account or a device this Worker can read.';
const BAD_VERIFIER = 'This app sent a malformed sign-in. Reload the page and try again.';

/**
 * Whose data a request is about.
 *
 * A token wins over anything in the body, always, and an unusable token is
 * refused rather than quietly demoted to whatever uid came with it. The device
 * id is a bearer secret by design — whoever holds it can read that device's
 * work, which is the promise localStorage already makes — but an account is
 * not, and accepting a uid alongside a token would hand a caller exactly that.
 */
export async function whoIs(body, env) {
  if (body?.token !== undefined && body?.token !== null && body?.token !== '') {
    if (!isToken(body.token)) return null;
    const account = await accountsOf(env)?.whose(body.token);
    return account ? { uid: account.id, account } : null;
  }
  if (ID.test(body?.uid || '')) return { uid: body.uid, account: null };
  return null;
}

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

/**
 * Every Gemini key this Worker was given, as one string for the client.
 *
 * The free tier is metered per key, so several keys is several times the daily
 * quota. Cloudflare has no list type, so they arrive either as one variable
 * holding many or as GEMINI_API_KEY_2 … _10 — both are read, because the
 * dashboard makes numbered variables easy and a wrangler file makes a list
 * easy, and someone will reasonably do either.
 */
const geminiKeysOf = (env) => [
  binding(env, 'GEMINI_API_KEYS'),
  binding(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY'),
  ...Array.from({ length: 9 }, (_, i) => binding(env, `GEMINI_API_KEY_${i + 2}`)),
].filter(Boolean).join(',');
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

/**
 * One turn with the app's actions available, Claude's way.
 *
 * Three things differ from Gemini and each is a silent failure if missed. The
 * schema field is `input_schema`, not `parameters`. A call comes back as a
 * `tool_use` content block rather than a `functionCall` part. And results go
 * back as `tool_result` blocks in a single user message — splitting them
 * across several messages quietly teaches the model to stop asking for more
 * than one thing at a time.
 *
 * `strict: true` is worth the two lines: it guarantees the arguments validate
 * against the schema, so a hallucinated shape is caught by Anthropic before it
 * reaches an action rather than by the action's own bounds check afterwards.
 */
async function claudeAct({ system, tools = [], messages = [] }, env, model) {
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
      ...(system ? { system } : {}),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { additionalProperties: false, required: [], ...t.parameters },
        strict: true,
      })),
      messages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new HttpError(res.status === 401 ? 401 : 502,
      `Claude responded ${res.status}. ${detail.slice(0, 200)}`);
  }

  const json = await res.json();
  const blocks = json?.content || [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
    // The id travels with the call: a result must name the call it answers.
    calls: blocks.filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
    turn: { role: 'assistant', content: blocks },
  };
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
      gemini: geminiKeyOf(env)
        ? `${geminiKeyCount()} key${geminiKeyCount() === 1 ? '' : 's'} set`
        : 'no GEMINI_API_KEY',
      claude: claudeKeyOf(env) ? 'key set' : 'no ANTHROPIC_API_KEY',
    },
    // Unset means this Worker answers any site that finds it, and they spend
    // your credit. Worth seeing at a glance rather than only in the docs.
    allowedOrigin: binding(env, 'ALLOWED_ORIGIN') || 'NOT SET — this Worker answers any website',
    sees: bindingNames(env),
    next: 'Full status at /api/health. Put this Worker\'s address into the app: Settings → AI help → Your server.',
  }),

  /**
   * A turn of the assistant, with the app's own actions available to it.
   *
   * The model runs nothing. It answers in words, or it names one of the
   * actions the app declared and the arguments it wants — and the app, on the
   * learner's device, decides whether to honour that. Keeping the decision on
   * the device is the point: the state never leaves it, and an action the
   * catalogue does not contain cannot be invented into existence here.
   *
   * Called twice per exchange in the usual case. First with the question, and
   * again with the results, so the reply can talk about what actually
   * happened rather than what was requested.
   */
  'POST /api/act': async (body, env) => {
    const who = body?.provider === 'gemini' ? 'gemini' : 'anthropic';
    const tools = Array.isArray(body?.tools) ? body.tools.slice(0, 24) : [];
    const history = Array.isArray(body?.history) ? body.history.slice(-12) : [];
    const question = String(body?.question || '').slice(0, 4000);

    if (who === 'gemini') {
      if (!geminiKeyOf(env)) return { ok: false, error: 'No GEMINI_API_KEY on this Worker.' };
      const out = await geminiAct({ system: body?.system || '', user: question, history, tools },
        body?.model);
      return { ok: true, text: out.text, calls: out.calls, turn: out.raw };
    }

    if (!claudeKeyOf(env)) return { ok: false, error: 'No ANTHROPIC_API_KEY on this Worker.' };
    const out = await claudeAct({
      system: body?.system || '',
      tools,
      messages: [...history, { role: 'user', content: question }],
    }, env, body?.model);
    return { ok: true, text: out.text, calls: out.calls, turn: out.turn };
  },

  /** The second half: hand back what the actions returned, get the reply. */
  'POST /api/act/result': async (body, env) => {
    const who = body?.provider === 'gemini' ? 'gemini' : 'anthropic';
    const history = Array.isArray(body?.history) ? body.history.slice(-12) : [];
    const results = Array.isArray(body?.results) ? body.results.slice(0, 8) : [];
    const tools = Array.isArray(body?.tools) ? body.tools.slice(0, 24) : [];

    if (who === 'gemini') {
      if (!geminiKeyOf(env)) return { ok: false, error: 'No GEMINI_API_KEY on this Worker.' };
      const out = await geminiAct({
        system: body?.system || '',
        history: [...history, ...results.map((r) => toolResult(r.name, r.result))],
        tools,
      }, body?.model);
      return { ok: true, text: out.text, calls: out.calls, turn: out.raw };
    }

    if (!claudeKeyOf(env)) return { ok: false, error: 'No ANTHROPIC_API_KEY on this Worker.' };
    /* Every result in one user message. Splitting them across several is
       accepted and then quietly trains the model out of asking for more than
       one thing at a time. */
    const out = await claudeAct({
      system: body?.system || '',
      tools,
      messages: [...history, {
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? null),
          ...(r.failed ? { is_error: true } : {}),
        })),
      }],
    }, env, body?.model);
    return { ok: true, text: out.text, calls: out.calls, turn: out.turn };
  },

  /* ── accounts ────────────────────────────────────────────────────────
   *
   * Optional, like everything below it. A guest gets the whole app; an
   * account only means the work outlives this browser.
   *
   * The password never arrives here — the browser stretches it first and
   * sends the result. accounts.mjs explains why, and what that does and does
   * not buy. These routes deal only in verifiers and tokens.
   */

  'POST /api/auth/signup': async (body, env, request) => {
    const users = accountsOf(env);
    if (!users) return { ok: false, error: NO_ACCOUNTS };

    const email = cleanEmail(body?.email);
    if (!email) return { ok: false, error: 'That does not look like an email address.' };
    if (!isVerifier(body?.verifier)) return { ok: false, error: BAD_VERIFIER };
    if (!(await withinRate(env, request?.headers?.get('cf-connecting-ip'), { perHour: 20 }))) {
      return { ok: false, error: 'Too many accounts from this network this hour.' };
    }

    /* Null means the unique index rejected it, which is also the only
       race-free way to ask. Saying so names an address that has an account
       here — unavoidable for a signup form, and the alternative is telling
       someone their new account works when it does not. */
    const made = await users.create({ email, name: cleanName(body?.name, email), verifier: body.verifier });
    if (!made) return { ok: false, error: 'That email already has an account. Sign in instead.' };

    return { ok: true, token: await users.open(made.id), user: made };
  },

  'POST /api/auth/login': async (body, env) => {
    const users = accountsOf(env);
    if (!users) return { ok: false, error: NO_ACCOUNTS };

    const email = cleanEmail(body?.email);
    if (!email || !isVerifier(body?.verifier)) return { ok: false, error: WRONG };

    /* Per account rather than per address: two students on one campus wifi
       must not be able to lock each other out, which is exactly what an
       address-keyed counter would let them do. */
    const locked = await users.lockedFor(email);
    if (locked) {
      return { ok: false, error: `Too many wrong attempts. Try again in ${locked} minute${locked === 1 ? '' : 's'}.` };
    }

    const row = await users.byEmail(email);
    /* One sentence for "no such account" and for "wrong password" alike. Two
       would turn this route into a way to ask whether someone has an account,
       which is not ours to answer.
     *
     * And one shape of work, too: skipping the comparison when there is no
     * row would answer measurably faster, which says the same thing the
     * message refuses to. So a miss is compared against a decoy. */
    const stored = row?.pass || DECOY;
    const good = await matches(body.verifier, stored);
    if (!row || !good) {
      await users.noteFailure(email);
      return { ok: false, error: WRONG };
    }

    await users.clearFailures(email);
    const user = { id: row.id, email: row.email, name: row.name };
    return { ok: true, token: await users.open(user.id), user };
  },

  /** Resume: the app asks on every start whether the token it kept still works. */
  'POST /api/auth/session': async (body, env) => {
    const users = accountsOf(env);
    if (!users) return { ok: false, error: NO_ACCOUNTS };
    if (!isToken(body?.token)) return { ok: false, error: 'Signed out.' };
    const user = await users.whose(body.token);
    return user ? { ok: true, user } : { ok: false, error: 'Signed out.' };
  },

  'POST /api/auth/logout': async (body, env) => {
    const users = accountsOf(env);
    if (!users || !isToken(body?.token)) return { ok: true };
    /* Everywhere is the one that matters after a lost phone, so it does not
       hide behind a second screen — but it needs a live session to name the
       account, which is why it resolves the token before ending it. */
    if (body?.everywhere) {
      const user = await users.whose(body.token);
      if (user) await users.closeAll(user.id);
    } else {
      await users.close(body.token);
    }
    return { ok: true };
  },

  /** Deleting has to be as easy as signing up, or "your data is yours" is a slogan. */
  'POST /api/auth/delete': async (body, env) => {
    const users = accountsOf(env);
    if (!users) return { ok: false, error: NO_ACCOUNTS };
    const who = await whoIs(body, env);
    if (!who?.account) return { ok: false, error: 'Signed out.' };
    await users.erase(who.account.id);
    return { ok: true, erased: true };
  },

  /* ── sync ────────────────────────────────────────────────────────────
   *
   * Optional. The app is complete without any of this; these routes exist so
   * progress and Ask history survive a cleared browser and follow someone to a
   * second device.
   *
   * Two ways to say who you are, and they are not equally strong. A signed-in
   * app sends its session token and the uid is resolved here, from the
   * session, never from the request. A guest sends the random id their device
   * made for itself — a bearer secret, exactly as strong as the localStorage
   * it replaces, and never the caller's IP. store.mjs says why not the IP.
   */
  'POST /api/sync/progress': async (body, env, request) => {
    const store = storeOf(env);
    if (!store) return { ok: false, error: NO_DB };
    const who = await whoIs(body, env);
    if (!who) return { ok: false, error: NOT_YOU };

    const snapshot = body?.snapshot;
    if (!snapshot || typeof snapshot !== 'object') {
      return { ok: false, error: 'No snapshot.' };
    }
    // A snapshot is counts and schedules; anything this large is not one.
    if (JSON.stringify(snapshot).length > LIMITS.snapshotBytes) {
      return { ok: false, error: 'Snapshot too large.' };
    }
    if (!(await withinRate(env, request?.headers?.get('cf-connecting-ip')))) {
      return { ok: false, error: 'Too many writes from this network this hour.' };
    }

    await store.saveProgress(who.uid, snapshot, new Date().toISOString());
    return { ok: true, at: new Date().toISOString() };
  },

  'POST /api/sync/progress/get': async (body, env) => {
    const store = storeOf(env);
    if (!store) return { ok: false, error: NO_DB };
    const who = await whoIs(body, env);
    if (!who) return { ok: false, error: NOT_YOU };
    const found = await store.loadProgress(who.uid);
    return { ok: true, found: Boolean(found), ...(found || {}) };
  },

  'POST /api/sync/chat': async (body, env, request) => {
    const store = storeOf(env);
    if (!store) return { ok: false, error: NO_DB };
    const who = await whoIs(body, env);
    if (!who) return { ok: false, error: NOT_YOU };
    const question = String(body?.question || '').slice(0, 4000);
    const answer = String(body?.answer || '').slice(0, 20000);
    if (!question || !answer) return { ok: false, error: 'Nothing to save.' };
    if (!(await withinRate(env, request?.headers?.get('cf-connecting-ip')))) {
      return { ok: false, error: 'Too many writes from this network this hour.' };
    }

    await store.addChat(who.uid, {
      at: new Date().toISOString(), question, answer, engine: body?.engine || null,
    });
    return { ok: true };
  },

  'POST /api/sync/chat/list': async (body, env) => {
    const store = storeOf(env);
    if (!store) return { ok: false, error: NO_DB };
    const who = await whoIs(body, env);
    if (!who) return { ok: false, error: NOT_YOU };
    return { ok: true, chats: await store.listChats(who.uid, Math.min(body?.limit || 50, 200)) };
  },

  /* Deleting has to be as easy as saving, or "your data is yours" is a slogan
     rather than a fact. This clears the work; /api/auth/delete clears the
     account itself along with it. */
  'POST /api/sync/forget': async (body, env) => {
    const store = storeOf(env);
    if (!store) return { ok: false, error: NO_DB };
    const who = await whoIs(body, env);
    if (!who) return { ok: false, error: NOT_YOU };
    await store.forget(who.uid);
    return { ok: true, forgotten: true };
  },

  'GET /api/health': (body, env) => ({
    ok: true,
    hasKey: Boolean(claudeKeyOf(env)),
    /* Accounts need D1 specifically — KV has no unique index, so it cannot
       promise one address is one account. The app reads this to decide
       whether to offer signing in at all, rather than offering it and
       failing at the last step. `rounds` must match what the browser does;
       publishing it is what makes a mismatch visible instead of looking
       like every password being wrong. */
    accounts: accountsOf(env) ? { rounds: CLIENT_ROUNDS, tries: MAX_TRIES } : false,
    model: CLAUDE_MODEL,
    push: false,
    runtime: 'cloudflare-worker',
    providers: {
      anthropic: { ready: Boolean(claudeKeyOf(env)), model: CLAUDE_MODEL },
      /* The count, never a key. A key in the wrong variable and no key at all
         look identical from outside, and this is what tells them apart. */
      gemini: { ready: hasGeminiKey(), model: geminiDefaultModel(), keys: geminiKeyCount() },
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
 * The origin the Android app runs on.
 *
 * The installed app serves itself from inside the APK over this origin — it is
 * fixed by Android, identical on every phone, and unreachable from the
 * internet. Allowed by default, because otherwise pinning ALLOWED_ORIGIN to
 * your website silently turns the AI off in the app and the only symptom is a
 * CORS error nobody sees.
 */
export const APP_ORIGIN = 'https://appassets.androidplatform.net';

/**
 * CORS.
 *
 * ALLOWED_ORIGIN unset means `*`, which is right for a scratch deployment and
 * wrong for a real one: it lets any page on the internet spend your API
 * credit. The health route says which you have.
 *
 * It takes a comma-separated list, and the reply echoes whichever entry the
 * request actually came from — a browser rejects a list in that header, so a
 * site with two origins (the www and the bare domain, say) needs the echo
 * rather than a longer string.
 */
export function cors(env, request) {
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',')
    .map((o) => o.trim()).filter(Boolean);
  const from = request?.headers?.get('origin') || '';

  let origin;
  if (!allowed.length) origin = '*';
  else if (allowed.includes(from) || from === APP_ORIGIN) origin = from;
  else origin = allowed[0];

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const headers = cors(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    // The Gemini client reads its key from here rather than from process.env,
    // which a Worker does not have.
    configureGemini({
      apiKey: geminiKeyOf(env),
      apiKeys: geminiKeysOf(env),
      model: binding(env, 'GEMINI_MODEL'),
    });

    const url = new URL(request.url);
    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) {
      return Response.json({ ok: false, error: 'Not found.' }, { status: 404, headers });
    }

    try {
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      // The request is passed too: the sync routes read the caller's address
      // to rate-limit writes, which is the one thing an IP is good for here.
      const out = await handler(body, env, request);
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
