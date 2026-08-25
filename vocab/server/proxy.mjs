#!/usr/bin/env node
/**
 * Lexio AI proxy.
 *
 * The only place the Anthropic API key exists. The browser talks to this; this
 * talks to Claude. It also serves the static app, so `npm start` gives you the
 * whole thing on one origin with no CORS to think about.
 *
 *   ANTHROPIC_API_KEY=sk-ant-…  npm start        → http://localhost:8787
 *
 * Routes
 *   GET  /api/health              is the key present, which model
 *   POST /api/ai/word             { term, level }            → study card JSON
 *   POST /api/ai/quiz             { term, definition, … }    → MCQ JSON
 *   POST /api/ai/suggest          { level, known, … }        → [{term, reason}]
 *   POST /api/ai/coach            { term, sentence, … }      → SSE text
 *   POST /api/ai/report           { stats }                  → SSE text
 *   GET  /api/push/public-key     VAPID public key
 *   POST /api/push/subscribe      store a PushSubscription
 *   POST /api/push/unsubscribe    drop one
 *   POST /api/push/test           push to every stored subscription
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  wordPrompt, wordSchema, quizPrompt, quizSchema,
  suggestPrompt, suggestSchema, coachPrompt, reportPrompt, assessPrompt,
} from './prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const SUBS_FILE = path.join(HERE, 'subscriptions.json');

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.LEXIO_MODEL || 'claude-opus-5';
const MAX_BODY = 64 * 1024;

// The SDK resolves ANTHROPIC_API_KEY (or an `ant auth login` profile) itself.
const client = new Anthropic();
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// ── Claude calls ───────────────────────────────────────────────────────────

/**
 * One structured-output request. `output_config.format` constrains the reply to
 * the given JSON schema, so the browser can trust the shape without validation
 * gymnastics. Effort is low — these are short, well-specified generations.
 */
async function askJson({ system, user }, schema, model = MODEL) {
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema },
    },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined this request.');
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Empty response from the model.');
  return JSON.parse(text);
}

/**
 * Streaming request: every text delta is forwarded to the browser as an SSE
 * frame, so feedback appears while it is being written.
 */
async function streamText({ system, user }, res, model = MODEL) {
  const stream = client.messages.stream({
    model,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'low' },
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      sse(res, { type: 'text_delta', text: event.delta.text });
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    sse(res, { type: 'error', error: 'The model declined this request.' });
  }
  sse(res, { type: 'done' });
  res.end();
}

// ── routing ────────────────────────────────────────────────────────────────

const routes = {
  'GET /api/health': async (req, res) => {
    json(res, 200, { ok: true, hasKey, model: MODEL, push: Boolean(vapid.publicKey) });
  },

  'POST /api/ai/word': async (req, res, body) => {
    requireKey();
    const term = String(body.term || '').trim().slice(0, 60);
    if (!term) throw new HttpError(400, 'No term given.');
    json(res, 200, { ok: true, data: await askJson(wordPrompt({ term, level: body.level }), wordSchema, pickModel(body)) });
  },

  'POST /api/ai/quiz': async (req, res, body) => {
    requireKey();
    if (!body.term) throw new HttpError(400, 'No term given.');
    const data = await askJson(quizPrompt(body), quizSchema, pickModel(body));
    // Belt and braces: the schema cannot express "answerIndex is within options".
    if (!Array.isArray(data.options) || data.options.length < 2) {
      throw new HttpError(502, 'Model returned an unusable question.');
    }
    data.answerIndex = Math.max(0, Math.min(data.options.length - 1, data.answerIndex | 0));
    json(res, 200, { ok: true, data });
  },

  'POST /api/ai/suggest': async (req, res, body) => {
    requireKey();
    const data = await askJson(suggestPrompt(body), suggestSchema, pickModel(body));
    json(res, 200, { ok: true, data: data.words.slice(0, Number(body.count) || 6) });
  },

  'POST /api/ai/coach': async (req, res, body) => {
    requireKey();
    if (!body.sentence) throw new HttpError(400, 'No sentence given.');
    openSse(res);
    await streamText(coachPrompt(body), res, pickModel(body));
  },

  'POST /api/ai/assess': async (req, res, body) => {
    requireKey();
    if (!body.estimate) throw new HttpError(400, 'No placement result given.');
    openSse(res);
    await streamText(assessPrompt({
      estimate: body.estimate,
      plan: body.plan || null,
      deck: body.deck || {},
    }), res, pickModel(body));
  },

  'POST /api/ai/report': async (req, res, body) => {
    requireKey();
    openSse(res);
    await streamText(reportPrompt({ stats: body.stats || {}, level: body.stats?.level }), res, pickModel(body));
  },

  /**
   * Translation. The browser can call Google's public endpoint itself, but
   * routing it here gives you one place to rate-limit and, if you have one, to
   * put an API key. Same response envelope as the AI routes.
   */
  'POST /api/translate': async (req, res, body) => {
    const text = String(body.text || '').trim().slice(0, 200);
    const to = String(body.to || '').trim();
    if (!text || !/^[a-zA-Z-]{2,7}$/.test(to)) throw new HttpError(400, 'Need `text` and a language code.');

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;

    // The public endpoint 500s intermittently — often enough that a single
    // attempt fails maybe one time in three. Three tries with a short backoff
    // makes that a non-event; still failing after that is a real outage.
    let upstream;
    for (const wait of [0, 250, 600]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      upstream = await fetch(url);
      if (upstream.status < 500) break;
    }
    if (!upstream.ok) throw new HttpError(502, `Translation upstream said ${upstream.status}.`);
    const payload = await upstream.json();
    const translated = (payload?.[0] || []).map((seg) => seg?.[0] || '').join('').trim();
    if (!translated) throw new HttpError(502, 'Translation upstream returned nothing.');
    json(res, 200, { ok: true, data: { text: translated, to } });
  },

  // ── push ────────────────────────────────────────────────────────────────
  'GET /api/push/public-key': async (req, res) => {
    json(res, 200, { publicKey: vapid.publicKey || null });
  },

  'POST /api/push/subscribe': async (req, res, body) => {
    if (!body.subscription?.endpoint) throw new HttpError(400, 'No subscription.');
    const subs = await loadSubs();
    const next = subs.filter((s) => s.subscription.endpoint !== body.subscription.endpoint);
    next.push({
      subscription: body.subscription,
      times: Array.isArray(body.times) && body.times.length ? body.times : ['20:00'],
      timezoneOffset: Number(body.timezoneOffset) || 0,
      lastFired: {},
      createdAt: Date.now(),
    });
    await saveSubs(next);
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res, body) => {
    const subs = await loadSubs();
    await saveSubs(subs.filter((s) => s.subscription.endpoint !== body.endpoint));
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const sent = await pushAll({ title: 'Lexio', body: 'Test push — reminders are working.' });
    json(res, 200, { ok: true, sent });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS: the app may be served from elsewhere (GitHub Pages, another port).
  // Lock ALLOWED_ORIGIN down in production.
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return serveStatic(url.pathname, res);

  if (!rateLimit(req)) return json(res, 429, { ok: false, error: 'Slow down a moment.' });

  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    await handler(req, res, body);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : (err.status || 500);
    const message = err instanceof HttpError ? err.message : describe(err);
    console.error(`[proxy] ${req.method} ${url.pathname} → ${status}: ${message}`);
    if (res.headersSent) { sse(res, { type: 'error', error: message }); res.end(); }
    else json(res, status, { ok: false, error: message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Lexio proxy   http://localhost:${PORT}`);
  console.log(`  model         ${MODEL}`);
  console.log(`  API key       ${hasKey ? 'loaded from the environment' : 'MISSING — set ANTHROPIC_API_KEY'}`);
  console.log(`  push          ${vapid.publicKey ? 'VAPID keys loaded' : 'disabled (no VAPID keys)'}`);
  console.log(`  app           serving ${path.relative(process.cwd(), APP_DIR) || '.'}\n`);
});

// ── helpers ────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireKey() {
  if (!hasKey) throw new HttpError(503, 'The proxy has no ANTHROPIC_API_KEY set.');
}

/** Allow the client to name a model, but only from a known-good list. */
function pickModel(body) {
  const allowed = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
  return allowed.includes(body?.model) ? body.model : MODEL;
}

function describe(err) {
  if (err?.status === 401) return 'Anthropic rejected the API key.';
  if (err?.status === 429) return 'Rate limited by the Anthropic API — try again shortly.';
  if (err?.status >= 500) return 'The Anthropic API is having trouble. Try again.';
  return err?.message || 'Unexpected proxy error.';
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) { reject(new HttpError(413, 'Request too large.')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'Body was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

/** Crude per-IP limiter — enough to stop a stuck loop burning your credit. */
const hits = new Map();
function rateLimit(req, limit = 40, windowMs = 60_000) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count <= limit;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(APP_DIR, rel);
  // Never serve outside the app directory, and never serve the server folder.
  if (!file.startsWith(APP_DIR) || file.startsWith(HERE)) {
    return json(res, 403, { ok: false, error: 'Forbidden.' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { ok: false, error: 'Not found.' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── web push (optional) ────────────────────────────────────────────────────
// Works only if `web-push` is installed and VAPID keys are set. Without them
// the app falls back to local reminders, which need no server at all.

const vapid = {
  publicKey: process.env.VAPID_PUBLIC_KEY || '',
  privateKey: process.env.VAPID_PRIVATE_KEY || '',
  subject: process.env.VAPID_SUBJECT || 'mailto:you@example.com',
};

let webpush = null;
if (vapid.publicKey && vapid.privateKey) {
  try {
    webpush = (await import('web-push')).default;
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  } catch {
    console.warn('[proxy] VAPID keys set but `web-push` is not installed — run: npm install web-push');
  }
}

async function loadSubs() {
  try { return JSON.parse(await fsp.readFile(SUBS_FILE, 'utf8')); } catch { return []; }
}
async function saveSubs(subs) {
  await fsp.writeFile(SUBS_FILE, JSON.stringify(subs, null, 2));
}

async function pushAll(payload) {
  if (!webpush) throw new HttpError(503, 'Push is not configured on this proxy.');
  const subs = await loadSubs();
  const alive = [];
  let sent = 0;
  for (const entry of subs) {
    try {
      await webpush.sendNotification(entry.subscription, JSON.stringify(payload));
      alive.push(entry);
      sent += 1;
    } catch (err) {
      // 404/410 mean the browser threw the subscription away — drop it.
      if (![404, 410].includes(err.statusCode)) alive.push(entry);
    }
  }
  await saveSubs(alive);
  return sent;
}

/**
 * Reminder scheduler: once a minute, push to any subscriber whose local
 * reminder time has just passed. Subscriptions carry the offset the browser
 * reported, so "20:00" means 20:00 where the learner is.
 */
if (webpush) {
  setInterval(async () => {
    const subs = await loadSubs();
    let changed = false;
    for (const entry of subs) {
      const local = new Date(Date.now() - entry.timezoneOffset * 60_000);
      const day = local.toISOString().slice(0, 10);
      const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
      for (const time of entry.times) {
        const [h, m] = time.split(':').map(Number);
        const slot = h * 60 + m;
        if (mins < slot || mins - slot > 30) continue;
        if (entry.lastFired?.[time] === day) continue;
        entry.lastFired = { ...entry.lastFired, [time]: day };
        changed = true;
        try {
          await webpush.sendNotification(entry.subscription, JSON.stringify({
            title: 'Time to review',
            body: 'Your words are waiting — two minutes keeps the streak.',
            view: 'learn',
          }));
        } catch { /* dropped on the next pushAll sweep */ }
      }
    }
    if (changed) await saveSubs(subs);
  }, 60_000).unref?.();
}
