/**
 * The built-in tutor — every AI feature answered on the device.
 *
 * The app ships 95,000 dictionary entries and every module pack, so the honest
 * answer to "what does this word mean" is almost always already here. This
 * module gives the same shapes `ai.js` returns from the proxy, built from that
 * data. Nothing here pretends to be Claude, and nothing here tells the learner
 * to go and configure a server before it will help them.
 */
import { Catalog } from './catalog.js';

/** Dictionary entry → the payload the word routes return. */
export async function localWord(term, level) {
  const hit = await Catalog.lookup(term).catch(() => null);
  if (!hit) {
    return {
      term,
      definition: '',
      examples: [],
      synonyms: [],
      antonyms: [],
      mnemonic: '',
      level: level || '',
      tags: ['custom'],
      note: `“${term}” is not in the built-in dictionary. Add your own meaning, or turn on Claude in Settings.`,
    };
  }
  return {
    ...hit,
    term,
    level: hit.level || level || '',
    examples: hit.examples?.length ? hit.examples : [],
    mnemonic: mnemonic(term, hit),
    tags: ['dictionary'],
  };
}

/**
 * A memory hook built from the word itself: its longest shared opening with a
 * synonym, or its shape. Crude, but it points at something real in the entry
 * rather than telling the learner to imagine something.
 */
function mnemonic(term, hit) {
  const near = (hit.synonyms || []).find((s) => s && s.toLowerCase() !== term.toLowerCase());
  if (near) return `Store it next to “${near}” — same neighbourhood of meaning.`;
  const first = (hit.definition || '').split(/[;,]/)[0].trim();
  return first ? `Hold on to the short version: ${first}.` : '';
}

/**
 * One panel that explains a word.
 *
 * The card above it is already showing the definition, the examples, the
 * synonym chips and the mnemonic. Repeating all four back was the fastest way
 * to make the panel look busy and say nothing, so this adds only what is *not*
 * on the card: the sense in plainer words, how the word behaves in a sentence,
 * and anything the dictionary holds that the card had no room for.
 */
export async function localExplain(word, level) {
  const hit = (await Catalog.lookup(word.term).catch(() => null)) || {};
  const definition = word.definition || hit.definition || '';
  const out = [];

  if (definition) {
    const plain = plainer(definition);
    // Only worth saying when it is actually shorter than what the card shows.
    if (plain.length < definition.length - 8) out.push(`The short version: ${plain}.`);
  }

  const pos = (word.pos || hit.pos || '').toLowerCase();
  if (USAGE[pos]) out.push(USAGE[pos].replace('%s', word.term));

  const extraSyn = dedupe(hit.synonyms || [], word.term)
    .filter((sy) => !(word.synonyms || []).some((k) => k.toLowerCase() === sy.toLowerCase()));
  if (extraSyn.length) out.push(`Also close in meaning: ${extraSyn.slice(0, 3).join(', ')}.`);

  if (!(word.examples || []).length) {
    out.push('', `This entry has no example sentence yet. Write one of your own in Practise → Writing coach and it will be checked.`);
  }

  if (!word.mnemonic) {
    const hook = mnemonic(word.term, { synonyms: [...(word.synonyms || []), ...extraSyn], definition });
    if (hook) out.push('', hook);
  }

  if (!out.filter(Boolean).length) {
    out.push(definition
      ? `The card already has the whole entry for “${word.term}”. Cover the meaning and say it out loud before you grade it — recall is what moves the card forward.`
      : `There is no entry for “${word.term}” on the device. Turn on Claude in Settings for a written explanation.`);
  }
  return out.join('\n').trim();
}

/** What each part of speech asks the learner to notice. */
const USAGE = {
  verb: 'It is a verb — check what it takes as an object before you use it.',
  noun: 'It is a noun — the article in front of it (a, the, none) is half the battle.',
  adjective: 'It is an adjective — try it both before a noun and after “is”.',
  adverb: 'It is an adverb — it usually sits next to the verb it changes.',
  preposition: 'It is a preposition — learn it inside the phrase, not on its own.',
  conjunction: 'It is a conjunction — it joins two halves, so write both.',
};

/** Trims a dictionary definition down to its first, plainest sense. */
function plainer(definition) {
  const first = definition.split(/\s*[;•]\s*/)[0].trim().replace(/[.]$/, '');
  return first.charAt(0).toLowerCase() + first.slice(1);
}

function dedupe(list, term) {
  const seen = new Set([term.toLowerCase()]);
  return list.filter((sy) => {
    const k = String(sy || '').toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Plain, checkable feedback on a learner's sentence. */
export function localCoach(term, sentence) {
  const text = (sentence || '').trim();
  if (!text) return `Write a sentence using “${term}” and I will check it.`;

  const notes = [];
  const used = usesWord(text, term);
  notes.push(used
    ? `✓ You used “${term}”.`
    : `✗ I cannot find “${term}” in that sentence — the word has to appear for the practice to count.`);

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 5) notes.push('✗ Too short to show the word doing any work. Aim for eight words or more.');
  else notes.push(`✓ Length is fine — ${words.length} words.`);

  if (!/^[A-Z"'“]/.test(text)) notes.push('✗ Start the sentence with a capital letter.');
  if (!/[.!?]["'”]?$/.test(text)) notes.push('✗ Finish the sentence with a full stop, question mark or exclamation mark.');
  if (/^[A-Z"'“]/.test(text) && /[.!?]["'”]?$/.test(text)) notes.push('✓ Punctuation looks right.');

  if (used && words.length >= 5) {
    notes.push('', 'Next step: rewrite it so the sentence would only work with this word — if a plainer word fits just as well, the sentence is not testing you yet.');
  }
  return notes.join('\n');
}

/**
 * Does the sentence contain the word, allowing ordinary inflections?
 *
 * Matching on a prefix of the term covers "adapt → adapted". English also drops
 * a silent -e before a vowel suffix ("adhere → adhering"), so the root has to
 * lose that -e too, or the learner gets told their own word is missing. The
 * root is never cut below four letters: "ads" must not match "advance".
 */
export function usesWord(sentence, term) {
  const lower = term.toLowerCase();
  let root = lower.replace(/(ing|ed|es|s)$/, '');
  if (root.length < 4) root = lower;
  if (root.length > 4 && root.endsWith('e')) root = root.slice(0, -1);
  return new RegExp(`\\b${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(sentence);
}

/** Words worth learning next, drawn from the module packs at the right band. */
export async function localSuggest({ level = 'B1', known = [], count = 6 } = {}) {
  const seen = new Set(known.map((t) => String(t).toLowerCase()));
  const bands = { A1: ['A2'], A2: ['A2'], B1: ['A2', 'B1'], B2: ['B1', 'B2'], C1: ['B2', 'C2'], C2: ['C2'] };
  const want = bands[level] || ['B1'];

  const manifest = await Catalog.modules().catch(() => []);
  const picks = [];
  for (const module of shuffle(manifest).slice(0, 3)) {
    const pack = await Catalog.pack(module.id).catch(() => null);
    if (!pack) continue;
    for (const entry of shuffle(pack.words).slice(0, 200)) {
      if (picks.length >= count) break;
      if (seen.has(entry.w) || !entry.d) continue;
      if (want.length && !want.includes(levelOf(entry.x))) continue;
      seen.add(entry.w);
      picks.push({ term: entry.w, reason: `${entry.d} — from ${module.title}.` });
    }
    if (picks.length >= count) break;
  }
  return picks;
}

const levelOf = (x) => ({ Easy: 'A2', Moderate: 'B1', Advanced: 'B2', 'God Level': 'C2' }[x] || '');

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The weekly write-up, from the numbers the app already tracks. */
export function localReport(p = {}) {
  const lines = [];
  const reviews = p.reviewsLast7Days ?? 0;
  const days = p.activeDaysLast7 ?? 0;

  lines.push(reviews
    ? `You reviewed ${reviews} ${reviews === 1 ? 'word' : 'words'} across ${days} ${days === 1 ? 'day' : 'days'} this week.`
    : 'No reviews this week yet — one set of ten is enough to restart the streak.');

  const accuracy = p.accuracyLast7Days;
  if (accuracy != null && reviews) {
    lines.push(accuracy >= 85
      ? `Accuracy ${accuracy}% — high enough that you can safely take on more new words per day.`
      : accuracy >= 70
        ? `Accuracy ${accuracy}% — a healthy range. Keep the daily goal where it is.`
        : `Accuracy ${accuracy}% — slow the new words down until the ones you have settle.`);
  }

  if (p.streak) lines.push(`Streak: ${p.streak} ${p.streak === 1 ? 'day' : 'days'}.`);
  if (p.deckSize) lines.push(`${p.knownWords ?? 0} of ${p.deckSize} words have moved into long-term review.`);

  if (p.strugglingWords?.length) {
    lines.push('', `Worth a second look: ${p.strugglingWords.map((w) => w.term).join(', ')}. Read each one in a sentence before grading it again.`);
  }
  return lines.join('\n');
}
