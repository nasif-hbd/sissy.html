/**
 * Signing in, and choosing not to.
 *
 * VocabX has always been usable by someone who never tells it who they are,
 * and that has not changed: a guest gets every screen, every word and every
 * feature, kept on their own device. An account adds exactly one thing — the
 * work outlives this browser, and follows you to a second device. Anywhere
 * this module fails, the app carries on as a guest.
 *
 * ── The password never leaves this file ──────────────────────────────────
 *
 * What goes to the server is a verifier: 250,000 rounds of PBKDF2 over the
 * password, done here. The server salts and stores that. It never receives
 * the password, so it cannot log one, leak one in a crash dump, or hand one
 * to a proxy in between — and because a guess still has to survive those
 * 250,000 rounds to produce a matching verifier, a stolen database is no
 * easier to crack than if the stretching had happened on the server.
 *
 * The count is fixed here and must match the Worker's CLIENT_ROUNDS. Changing
 * it makes every existing password wrong, so it is versioned in the salt
 * rather than edited in place.
 *
 * It costs a few hundred milliseconds on a phone. That is the point of it —
 * and it is why signing in shows that it is working rather than appearing to
 * hang.
 */
import { AI } from './config.js';
import { proxyBase } from './ai.js';

const TOKEN = 'vocabx.session';
const CACHED = 'vocabx.account';
const CHOSE = 'vocabx.welcomed';

/** Must match CLIENT_ROUNDS in server/accounts.mjs. */
export const ROUNDS = 250_000;
/* Mixed into the salt so the same password on another site that hashes the
   same way does not produce the same verifier — and so a future change of
   scheme can be told apart from this one instead of silently colliding. */
const REALM = 'vocabx:v1:';

const enc = new TextEncoder();

/* Every read is wrapped: a browser in private mode, or with storage switched
   off, throws on access rather than returning null — and an app that cannot
   remember a session should still start. */
const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); }
  catch { /* nothing to be done, and nothing worth interrupting for */ }
};

/**
 * The slow part, and the only part that touches the password.
 *
 * The email is the salt. Per-account salting is what stops one cracked
 * password from being every account that chose it, and using the address
 * means no round trip before we can even hash — which would otherwise be a
 * public way to ask whether an address has an account here.
 */
export async function stretch(email, password) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256',
    salt: enc.encode(REALM + String(email).trim().toLowerCase()),
    iterations: ROUNDS,
  }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether this build could sign anyone in at all. */
export function possible() {
  // deriveBits needs a secure context. https and the installed app both have
  // one; a page opened from the filesystem does not, and should be told so
  // rather than shown a form that cannot work.
  return Boolean(proxyBase() && globalThis.crypto?.subtle?.deriveBits);
}

async function post(route, payload, ms = 20_000) {
  const res = await fetch(`${proxyBase()}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined,
  });
  return res.json();
}

export const Auth = {
  /** The signed-in account, or null. Cached so the header can draw at once. */
  user: (() => { try { return JSON.parse(read(CACHED)) || null; } catch { return null; } })(),

  get token() { return read(TOKEN); },
  get isIn() { return Boolean(this.token && this.user); },

  /** Whether someone has answered the welcome screen — either way counts. */
  get chose() { return read(CHOSE) === '1' || Boolean(this.token); },

  /** Remember that they chose, so the welcome is a first-run and not a wall. */
  settle() { write(CHOSE, '1'); },

  /** Guest: no account, everything local. A choice, not a failure to sign in. */
  guest() {
    this.settle();
    return { ok: true, guest: true };
  },

  hold(token, user) {
    write(TOKEN, token);
    write(CACHED, JSON.stringify(user));
    this.user = user;
    this.settle();
  },

  drop() {
    write(TOKEN, null);
    write(CACHED, null);
    this.user = null;
  },

  async signup({ email, password, name }) {
    const verifier = await stretch(email, password);
    const out = await post('/api/auth/signup', { email, name, verifier });
    if (out?.ok) this.hold(out.token, out.user);
    return out;
  },

  async login({ email, password }) {
    const verifier = await stretch(email, password);
    const out = await post('/api/auth/login', { email, verifier });
    if (out?.ok) this.hold(out.token, out.user);
    return out;
  },

  /**
   * Is the kept token still good?
   *
   * Three outcomes, and the middle one matters: signed in, definitely signed
   * out, or unreachable. Only the second clears the session — dropping it
   * because the network was down would sign someone out of their own app
   * every time they opened it on a train.
   */
  async resume() {
    if (!this.token) return { ok: false, out: true };
    try {
      const res = await post('/api/auth/session', { token: this.token }, 8000);
      if (res?.ok) { this.hold(this.token, res.user); return { ok: true, user: res.user }; }
      this.drop();
      return { ok: false, out: true };
    } catch {
      return { ok: false, offline: true };
    }
  },

  async logout({ everywhere = false } = {}) {
    const token = this.token;
    this.drop();
    // The local half is done either way; the server's is best effort, because
    // a signed-out screen that stays signed in because the wifi dropped is
    // worse than a session row that outlives its use.
    if (token) { try { await post('/api/auth/logout', { token, everywhere }); } catch { /* it lapses */ } }
  },

  /** Change the display name on the account. Guests keep theirs in the store. */
  async rename(name) {
    const token = this.token;
    if (!token) return { ok: false, error: 'Not signed in.' };
    const out = await post('/api/auth/rename', { token, name });
    if (out?.ok) this.hold(token, out.user);
    return out;
  },

  /** Delete the account and everything kept with it, server-side. */
  async erase() {
    const token = this.token;
    if (!token) return { ok: false, error: 'Not signed in.' };
    const out = await post('/api/auth/delete', { token });
    if (out?.ok) this.drop();
    return out;
  },
};

/**
 * Whether the deployment can hold accounts at all.
 *
 * A Worker with no database bound answers plainly, and the welcome screen
 * would rather say so than show a form whose last step fails.
 *
 * Only a yes is remembered. A no is very often just "offline at the moment",
 * and caching that for the life of the page means someone who opened the app
 * on a train is told accounts do not exist for the rest of the session — on a
 * deployment where they do.
 */
let known = null;
export function serverAccounts() {
  if (known) return known;
  const asking = (async () => {
    if (!possible()) return false;
    try {
      const res = await fetch(`${proxyBase()}${AI.routes.health}`, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined,
      });
      const body = await res.json();
      const can = body?.accounts || false;
      if (can) known = Promise.resolve(can);
      return can;
    } catch {
      return false;
    }
  })();
  return asking;
}
