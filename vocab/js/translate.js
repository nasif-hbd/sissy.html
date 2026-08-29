/**
 * Translation into six languages.
 *
 * Three sources, cheapest first:
 *   1. the dataset — Bangla, Hindi and Chinese ship with many words already,
 *      so those are instant, offline and cost nothing;
 *   2. the local cache — every fetched translation is kept, so a word is
 *      translated once per device;
 *   3. Google Translate — the public endpoint, called straight from the page.
 *      If a proxy is configured it is used instead, which is what you want in
 *      production: one place to rate-limit, and a key if you have one.
 */
import { Store } from './store.js';
import { Catalog } from './catalog.js';

export const LANGUAGES = [
  { id: 'off',   label: 'Off',      english: 'No translation' },
  { id: 'bn',    label: 'বাংলা',    english: 'Bangla',   field: 'bn' },
  { id: 'hi',    label: 'हिन्दी',    english: 'Hindi',    field: 'hi' },
  { id: 'es',    label: 'Español',  english: 'Spanish' },
  { id: 'ar',    label: 'العربية',   english: 'Arabic',  rtl: true },
  { id: 'zh-CN', label: '中文',      english: 'Mandarin', field: 'zh-CN' },
  { id: 'ru',    label: 'Русский',  english: 'Russian' },
];

const CACHE_KEY = 'vocabx.translations.v1';
const MAX_CACHED = 4000;

let cache = load();

function load() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
}

function remember(key, value) {
  cache[key] = value;
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHED) for (const k of keys.slice(0, keys.length - MAX_CACHED)) delete cache[k];
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* full; not fatal */ }
}

export const Translate = {
  get language() { return Store.get('settings.language', 'off'); },
  get active() { return this.language !== 'off'; },
  info(id = this.language) { return LANGUAGES.find((l) => l.id === id); },

  /**
   * Translate one word. `word` is the stored record, which may already carry a
   * translation from the dataset.
   * @returns {Promise<{text: string, source: 'deck'|'cache'|'google'}|null>}
   */
  async word(word, lang = this.language) {
    if (lang === 'off' || !word?.term) return null;

    const field = this.info(lang)?.field;
    const shipped = field && word.tr?.[field];
    if (shipped) return { text: shipped, source: 'deck' };

    const key = `${lang}:${word.term.toLowerCase()}`;
    if (cache[key]) return { text: cache[key], source: 'cache' };

    // Bangla, Hindi and Mandarin ship with the dictionary, so a word added
    // before those fields existed — or typed in by hand — can still be
    // translated without touching the network.
    if (field) {
      const entry = await Catalog.lookup(word.term).catch(() => null);
      const known = entry?.tr?.[field];
      if (known) { remember(key, known); return { text: known, source: 'dictionary' }; }
    }

    const text = await fetchTranslation(word.term, lang);
    if (!text) return null;
    remember(key, text);
    return { text, source: 'google' };
  },

  /** Clear the on-device cache (Settings → Your copy). */
  forget() {
    cache = {};
    try { localStorage.removeItem(CACHE_KEY); } catch { /* nothing to do */ }
  },
};

async function fetchTranslation(term, lang) {
  const base = Store.get('settings.ai.mode') === 'proxy'
    ? (Store.get('settings.ai.endpoint') || '').replace(/\/+$/, '')
    : '';

  try {
    if (base) {
      const res = await fetch(`${base}/api/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: term, to: lang }),
        signal: AbortSignal.timeout?.(7000),
      });
      if (res.ok) {
        const body = await res.json();
        if (body?.data?.text) return body.data.text;
      }
    }

    // The public endpoint answers with CORS open, so the page can call it
    // directly. Shape: [[["translated","source",…], …], …]
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(term)}`;
    // Without a deadline a blocked or slow network leaves the card showing an
    // ellipsis for ever. The endpoint also 500s intermittently, so one retry.
    let res;
    for (const wait of [0, 250, 600]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      res = await fetch(url, { signal: AbortSignal.timeout?.(7000) });
      if (res.status < 500) break;
    }
    if (!res?.ok) return null;
    const json = await res.json();
    const text = (json?.[0] || []).map((seg) => seg?.[0] || '').join('').trim();
    return text && text.toLowerCase() !== term.toLowerCase() ? text : null;
  } catch {
    return null;   // offline, blocked, or rate-limited — the card just omits it
  }
}
