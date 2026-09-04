/**
 * Where a learner's work is kept, when it is kept anywhere at all.
 *
 * VocabX works with no server: everything lives in localStorage on the device.
 * This is the optional other half — a place to put progress and Ask history so
 * they survive a cleared browser and follow someone to a second device.
 *
 * ── Why not the IP address ──────────────────────────────────────────────────
 *
 * The obvious key is the caller's IP, and it is the wrong one, in a way that
 * gets worse the more the app succeeds. Mobile carriers put thousands of
 * subscribers behind one public address (CGNAT) — so two students on the same
 * network would read and overwrite each other's progress and each other's
 * chats. And an IP changes when you move cell, rejoin wifi, or the lease
 * rolls, so the work would vanish for reasons nobody could see. It fails both
 * ways at once: strangers merged, and your own history lost.
 *
 * The key is a random id the device makes for itself and never shows anyone.
 * It is not a login and does not pretend to be: whoever holds the id holds the
 * data, which is the same promise localStorage already makes.
 *
 * The IP is still read, once, for rate limiting — a single number of writes
 * per hour, kept only as a counter that expires. It is never a key and never
 * stored beside a chat.
 */

/** Ids are opaque to us, but a malformed one must never reach a query. */
export const ID = /^[A-Za-z0-9_-]{16,64}$/;

/** How much of a learner's history is worth keeping. Chats are the long tail. */
export const LIMITS = { chats: 200, snapshotBytes: 256 * 1024 };

/**
 * An adapter over whatever the Worker was given.
 *
 * D1 is the right home — this is relational data and it can be queried. KV is
 * accepted because a binding menu makes them look interchangeable and someone
 * will pick the wrong one; better to work slightly worse than to fail with a
 * message about the wrong noun.
 */
export function storeOf(env) {
  const db = env?.DB || env?.VOCABX_DB || env?.STORE;
  if (!db) return null;

  if (typeof db.prepare === 'function') return d1(db);
  if (typeof db.put === 'function') return kv(db);
  return null;
}

function d1(db) {
  /* Made on demand. Nobody should have to run a migration by hand before the
     app can save anything, and CREATE TABLE IF NOT EXISTS is cheap. */
  const ready = db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS progress ('
      + 'uid TEXT PRIMARY KEY, at TEXT NOT NULL, snapshot TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS chats ('
      + 'id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, at TEXT NOT NULL, '
      + 'question TEXT NOT NULL, answer TEXT NOT NULL, engine TEXT)'),
    // Without this, every read of one learner's chats scans everyone's.
    db.prepare('CREATE INDEX IF NOT EXISTS chats_by_user ON chats (uid, id DESC)'),
  ]);

  return {
    kind: 'D1',

    async saveProgress(uid, snapshot, at) {
      await ready;
      await db.prepare('INSERT INTO progress (uid, at, snapshot) VALUES (?, ?, ?) '
        + 'ON CONFLICT(uid) DO UPDATE SET at = excluded.at, snapshot = excluded.snapshot')
        .bind(uid, at, JSON.stringify(snapshot)).run();
    },

    async loadProgress(uid) {
      await ready;
      const row = await db.prepare('SELECT at, snapshot FROM progress WHERE uid = ?')
        .bind(uid).first();
      if (!row) return null;
      try { return { at: row.at, snapshot: JSON.parse(row.snapshot) }; }
      catch { return null; }
    },

    async addChat(uid, turn) {
      await ready;
      await db.prepare(
        'INSERT INTO chats (uid, at, question, answer, engine) VALUES (?, ?, ?, ?, ?)')
        .bind(uid, turn.at, turn.question, turn.answer, turn.engine || null).run();
      /* Trimmed on write rather than swept later: a Worker has no cron of its
         own here, and an unbounded table is a bill nobody notices growing. */
      await db.prepare('DELETE FROM chats WHERE uid = ? AND id NOT IN '
        + '(SELECT id FROM chats WHERE uid = ? ORDER BY id DESC LIMIT ?)')
        .bind(uid, uid, LIMITS.chats).run();
    },

    async listChats(uid, limit = 50) {
      await ready;
      const out = await db.prepare('SELECT at, question, answer, engine FROM chats '
        + 'WHERE uid = ? ORDER BY id DESC LIMIT ?').bind(uid, limit).all();
      return out.results || [];
    },

    async forget(uid) {
      await ready;
      await db.batch([
        db.prepare('DELETE FROM progress WHERE uid = ?').bind(uid),
        db.prepare('DELETE FROM chats WHERE uid = ?').bind(uid),
      ]);
    },
  };
}

function kv(store) {
  /* KV has no queries, so the chat list is one value per learner rewritten on
     each turn. That is fine at this size and would not be at a thousand. */
  const chatsKey = (uid) => `chats:${uid}`;
  const progressKey = (uid) => `progress:${uid}`;

  const readChats = async (uid) => {
    try { return JSON.parse(await store.get(chatsKey(uid))) || []; }
    catch { return []; }
  };

  return {
    kind: 'KV',

    async saveProgress(uid, snapshot, at) {
      await store.put(progressKey(uid), JSON.stringify({ at, snapshot }));
    },

    async loadProgress(uid) {
      try { return JSON.parse(await store.get(progressKey(uid))) || null; }
      catch { return null; }
    },

    async addChat(uid, turn) {
      const rows = await readChats(uid);
      rows.unshift(turn);
      await store.put(chatsKey(uid), JSON.stringify(rows.slice(0, LIMITS.chats)));
    },

    async listChats(uid, limit = 50) {
      return (await readChats(uid)).slice(0, limit);
    },

    async forget(uid) {
      await Promise.all([store.delete(progressKey(uid)), store.delete(chatsKey(uid))]);
    },
  };
}

/**
 * A write budget per address, so one script cannot fill the database.
 *
 * The address is hashed and the counter expires, so what is kept is "someone
 * wrote 40 times this hour", not "this person was here". Best effort: without
 * a store there is no limiter, and the routes still work.
 */
export async function withinRate(env, ip, { perHour = 120 } = {}) {
  const kvStore = env?.RATE || env?.FEEDBACK;
  if (!kvStore || typeof kvStore.put !== 'function' || !ip) return true;

  const key = `rate:${await sha(ip)}:${new Date().toISOString().slice(0, 13)}`;
  const seen = Number(await kvStore.get(key)) || 0;
  if (seen >= perHour) return false;
  // Two hours, so the hour-boundary key is gone well before it could be reused.
  await kvStore.put(key, String(seen + 1), { expirationTtl: 7200 });
  return true;
}

async function sha(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}
