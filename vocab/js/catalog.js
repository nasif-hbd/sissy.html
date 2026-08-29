/**
 * The shipped vocabulary: study modules and the full dictionary.
 *
 * Both are generated from the source CSV by `scripts/build-modules.mjs` and
 * fetched on demand — a module pack when the learner opens it, a dictionary
 * shard when they type a word. Nothing here is loaded at boot, so the app still
 * starts on one small payload.
 */
const MODULES_URL = 'data/modules';
const DICT_URL = 'data/dict';
const GRAMMAR_URL = 'data/grammar/bank.json';

const packs = new Map();     // id  -> pack
const shards = new Map();    // key -> words
let manifest = null;
let dictIndex = null;
let grammarBank = null;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

export const Catalog = {
  /** The module list for the Modules tab. Cached for the session. */
  async modules() {
    if (!manifest) manifest = await getJson(`${MODULES_URL}/index.json`);
    return manifest;
  },

  /** The shipped grammar bank. One file, fetched when the Test tab needs it. */
  async grammar() {
    grammarBank ??= (await getJson(GRAMMAR_URL)).items;
    return grammarBank;
  },

  /** One module with its words. Fetched the first time it is opened. */
  async pack(id) {
    if (!packs.has(id)) packs.set(id, await getJson(`${MODULES_URL}/${id}.json`));
    return packs.get(id);
  },

  /**
   * Look a word up in the shipped dictionary — 117,000 entries, so most words a
   * learner types are already here and no AI call is needed.
   * Returns a word payload shaped like the AI's, or null.
   */
  async lookup(term) {
    const w = term.trim().toLowerCase();
    if (!/^[a-z][a-z'-]*$/.test(w)) return null;

    if (!dictIndex) {
      try { dictIndex = await getJson(`${DICT_URL}/index.json`); }
      catch { return null; }
    }

    // Shard keys are letters only — the builder collapses anything else to an
    // underscore, and this has to match it exactly. Fat two-letter buckets were
    // split three deep at build time; the index says which.
    const prefix = (n) => w.slice(0, n).replace(/[^a-z]/g, '_').padEnd(n, '_');
    const two = prefix(2);
    const key = dictIndex.deep?.includes(two) ? prefix(3) : two;

    if (!shards.has(key)) {
      try { shards.set(key, await getJson(`${DICT_URL}/${key}.json`)); }
      catch { shards.set(key, {}); }
    }
    const hit = shards.get(key)[w];
    return hit ? toWord(w, hit) : null;
  },

  /** How many words of a module are already in the deck. */
  progress(pack, state) {
    let have = 0;
    for (const entry of pack.words) if (state.words[entry.w]) have += 1;
    return have;
  },
};

/** Dataset record → the shape store.addWord expects. */
export function toWord(term, r) {
  return {
    term,
    pos: r.p || '',
    definition: r.d || '',
    examples: [],
    synonyms: r.s || [],
    antonyms: [],
    mnemonic: '',
    level: levelOf(r.x),
    tags: [],
    tr: { bn: r.bn || '', hi: r.hi || '', 'zh-CN': r.zh || '' },
  };
}

/** The dataset's own difficulty bands, mapped onto CEFR-ish labels. */
function levelOf(difficulty) {
  return { Easy: 'A2', Moderate: 'B1', Advanced: 'B2', 'God Level': 'C2' }[difficulty] || '';
}
