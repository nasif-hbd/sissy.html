/**
 * Accounts: who someone is, and how they stay signed in.
 *
 * The app has never needed this and still does not — a guest gets every
 * feature, and everything is kept on their own device. What an account adds is
 * that clearing a browser, or picking up a second device, no longer means
 * starting from zero. That is the whole of it.
 *
 * ── Where the password work happens ──────────────────────────────────────
 *
 * Not here, and this is the one decision in this file worth reading twice.
 *
 * A Cloudflare Worker on the free plan gets ten milliseconds of CPU per
 * request. A password hash worth having costs a hundred times that: PBKDF2 at
 * any honest iteration count would blow the budget and fail every signup on
 * the plan this app is actually deployed on. Lowering the count until it fits
 * would leave a hash an attacker can grind through — the appearance of a
 * defence rather than one.
 *
 * So the stretching runs in the browser, which has CPU to spare and is idle
 * anyway. What reaches this file is already a slow-derived value: the
 * verifier. The server salts it, hashes it once more, and stores that.
 *
 * The property that matters survives intact. Someone holding a stolen copy of
 * the database still has to run 250,000 PBKDF2 iterations for every password
 * they want to test, because the verifier is what a guess has to reproduce.
 * All that moved is where those iterations are spent. What the server gains is
 * that it never handles the password at all — not in a log, a crash dump, or
 * anyone's proxy trace.
 *
 * What it costs is honest to state: the verifier is password-equivalent while
 * it is in flight, so this leans on HTTPS — exactly as sending the password
 * itself would. And a client that skips the stretching can send anything it
 * likes; that only weakens the account doing it, which is the same bargain as
 * choosing a bad password.
 *
 * ── Sessions ─────────────────────────────────────────────────────────────
 *
 * A session token is 32 bytes from the CSPRNG. The database stores only its
 * SHA-256, so a leaked table cannot be used to sign in as anybody. A plain
 * fast hash is right here and would be wrong above: there is nothing to
 * stretch when the input is already 256 bits of uniform randomness.
 */

/** Only D1 can hold accounts — KV has no unique index and no transaction. */
export function accountsOf(env) {
  const db = env?.DB || env?.VOCABX_DB || env?.STORE;
  if (!db || typeof db.prepare !== 'function') return null;
  return table(db);
}

/* Long enough that signing in is a rare event, short enough that a token
   copied off an old device stops working. Renewed on use once it is inside
   the last month, so a daily learner is never signed out mid-term. */
export const SESSION_DAYS = 90;
export const RENEW_WITHIN_DAYS = 30;

/* Eight wrong answers buys a quarter of an hour of silence. Per account, not
   per address: two students on one campus wifi must not be able to lock each
   other out, which is what an address-keyed counter would do. */
export const MAX_TRIES = 8;
export const LOCK_MINUTES = 15;

/** How hard the browser is asked to work. Changing this breaks old passwords. */
export const CLIENT_ROUNDS = 250_000;
/* And how hard the server works on the already-stretched result. Deliberately
   small: it is insurance against a weak verifier, not the defence itself, and
   the defence is the quarter-million rounds that produced its input. */
const SERVER_ROUNDS = 1_000;

const enc = new TextEncoder();

// ── the shapes an account is allowed to have ───────────────────────────────

/**
 * Deliberately permissive. The address is an identifier here, not a channel —
 * nothing is ever sent to it — so the only real requirements are that it has
 * the shape people expect and that it cannot be confused with another one.
 */
export function cleanEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (email.length < 5 || email.length > 160) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

/** The browser's PBKDF2 output, hex. Anything else did not come from us. */
export const isVerifier = (v) => /^[0-9a-f]{64}$/.test(String(v || ''));

export function cleanName(raw, email) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (name) return name;
  // A sane default beats an empty header: the part before the @, capitalised.
  const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local ? local[0].toUpperCase() + local.slice(1, 40) : 'Learner';
}

// ── crypto ─────────────────────────────────────────────────────────────────

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

/** A session token: url-safe, 32 bytes, never stored as given. */
export function newToken() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const isToken = (t) => /^[A-Za-z0-9_-]{40,64}$/.test(String(t || ''));

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
}

/** `salt$hash` — the salt is per account, so two equal passwords do not match. */
export async function lockUp(verifier, salt = randomHex(16)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(verifier), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: SERVER_ROUNDS }, key, 256);
  return `${salt}$${hex(bits)}`;
}

/**
 * Whether a verifier matches what was stored, without leaking how nearly.
 *
 * A comparison that stops at the first wrong character reports, in how long
 * it took, how much of the hash the caller guessed right. Over enough tries
 * that is the hash. This one always reads to the end.
 */
export async function matches(verifier, stored) {
  const [salt] = String(stored || '').split('$');
  if (!salt) return false;
  const again = await lockUp(verifier, salt);
  if (again.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < again.length; i += 1) diff |= again.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

const now = () => new Date().toISOString();
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

// ── storage ────────────────────────────────────────────────────────────────

function table(db) {
  /* Made on demand, like the rest of the schema. Nobody should have to run a
     migration by hand before the app can hold an account. */
  const ready = db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS users ('
      + 'id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, '
      + 'pass TEXT NOT NULL, made TEXT NOT NULL, seen TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS sessions ('
      + 'token TEXT PRIMARY KEY, uid TEXT NOT NULL, made TEXT NOT NULL, until TEXT NOT NULL)'),
    // Without this, signing out everywhere scans every session on the server.
    db.prepare('CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (uid)'),
    db.prepare('CREATE TABLE IF NOT EXISTS tries ('
      + 'email TEXT PRIMARY KEY, n INTEGER NOT NULL, until TEXT NOT NULL)'),
  ]);

  /* `made` travels with the account so a profile can say "member since"
     truthfully. The local install date cannot: signing in on a new phone
     would date the membership to this morning. */
  const account = (row) =>
    (row ? { id: row.id, email: row.email, name: row.name, made: row.made } : null);

  return {
    /** The id is what sync keys on, so it is opaque and never the email. */
    async create({ email, name, verifier }) {
      await ready;
      const id = `u${randomHex(16)}`;
      const made = now();
      const pass = await lockUp(verifier);
      try {
        await db.prepare('INSERT INTO users (id, email, name, pass, made, seen) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, email, name, pass, made, made).run();
      } catch (err) {
        // The unique index is the only thing that can reject this, and it is
        // also the only thing that makes the check race-free.
        if (/UNIQUE|constraint/i.test(err?.message || '')) return null;
        throw err;
      }
      return { id, email, name, made };
    },

    async byEmail(email) {
      await ready;
      return db.prepare('SELECT id, email, name, pass, made FROM users WHERE email = ?')
        .bind(email).first();
    },

    async byId(id) {
      await ready;
      return account(await db.prepare('SELECT id, email, name, made FROM users WHERE id = ?')
        .bind(id).first());
    },

    /** Mint a session and hand back the only copy of the token. */
    async open(uid) {
      await ready;
      const token = newToken();
      await db.prepare('INSERT INTO sessions (token, uid, made, until) VALUES (?, ?, ?, ?)')
        .bind(await sha256(token), uid, now(), inDays(SESSION_DAYS)).run();
      await db.prepare('UPDATE users SET seen = ? WHERE id = ?').bind(now(), uid).run();
      return token;
    },

    /**
     * Who a token belongs to, or null. Expiry is checked here rather than by
     * a sweep: a Worker has no cron, and a row that outlived its date must
     * not be usable just because nothing came along to delete it.
     */
    async whose(token) {
      await ready;
      const hash = await sha256(token);
      const row = await db.prepare(
        'SELECT s.until AS until, u.id AS id, u.email AS email, u.name AS name, u.made AS made '
        + 'FROM sessions s JOIN users u ON u.id = s.uid WHERE s.token = ?').bind(hash).first();
      if (!row) return null;
      if (row.until <= now()) {
        await db.prepare('DELETE FROM sessions WHERE token = ?').bind(hash).run();
        return null;
      }
      // Renewed only near the end, so a daily learner is never signed out and
      // an active session is not one database write per request.
      if (row.until < inDays(RENEW_WITHIN_DAYS)) {
        await db.prepare('UPDATE sessions SET until = ? WHERE token = ?')
          .bind(inDays(SESSION_DAYS), hash).run();
      }
      return account(row);
    },

    async close(token) {
      await ready;
      await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256(token)).run();
    },

    async closeAll(uid) {
      await ready;
      await db.prepare('DELETE FROM sessions WHERE uid = ?').bind(uid).run();
    },

    /** How long this account is locked out for, or null. */
    async lockedFor(email) {
      await ready;
      const row = await db.prepare('SELECT n, until FROM tries WHERE email = ?').bind(email).first();
      if (!row || row.n < MAX_TRIES || row.until <= now()) return null;
      return Math.max(1, Math.round((Date.parse(row.until) - Date.now()) / 60_000));
    },

    async noteFailure(email) {
      await ready;
      const until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
      /* The window restarts on each failure, so eight spread over an hour do
         not add up to a lockout while eight in a row do. */
      await db.prepare('INSERT INTO tries (email, n, until) VALUES (?, 1, ?) '
        + 'ON CONFLICT(email) DO UPDATE SET '
        + 'n = CASE WHEN tries.until <= ? THEN 1 ELSE tries.n + 1 END, until = ?')
        .bind(email, until, now(), until).run();
    },

    async clearFailures(email) {
      await ready;
      await db.prepare('DELETE FROM tries WHERE email = ?').bind(email).run();
    },

    /** The one thing about an account its owner can change. */
    async rename(uid, name) {
      await ready;
      await db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, uid).run();
    },

    /**
     * Everything about someone, gone. Progress and chats go with it.
     *
     * Those two tables belong to store.mjs and are created the first time
     * anything syncs, which may be never — so they are cleared separately and
     * a missing table is not allowed to leave the account itself standing.
     * Deleting less than asked would be the worse failure of the two.
     */
    async erase(uid) {
      await ready;
      for (const sql of ['DELETE FROM progress WHERE uid = ?', 'DELETE FROM chats WHERE uid = ?']) {
        try { await db.prepare(sql).bind(uid).run(); } catch { /* never synced */ }
      }
      await db.batch([
        db.prepare('DELETE FROM sessions WHERE uid = ?').bind(uid),
        db.prepare('DELETE FROM users WHERE id = ?').bind(uid),
      ]);
    },
  };
}
