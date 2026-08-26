/**
 * Ask — the tutor you can talk to.
 *
 * Everywhere else in the app the AI answers a question the app chose. Here the
 * learner chooses, which is a different job: they arrive with "what's the
 * difference between affect and effect", or a sentence they are not sure about,
 * and no menu covers that.
 *
 * Two halves, as everywhere else. With Claude connected the whole conversation
 * goes to the proxy. Without it, this reads the question well enough to answer
 * the common cases from the 95,000-word dictionary already on the device —
 * "what does X mean", "X vs Y", "use X in a sentence" — and says plainly when a
 * question is beyond what it can do offline rather than inventing an answer.
 */
import { Catalog } from './catalog.js';

/** How much of the conversation is sent as context. Keeps the bill small. */
export const HISTORY_LIMIT = 12;

export const STARTERS = [
  'What does “ubiquitous” mean?',
  'What is the difference between affect and effect?',
  'Use “meticulous” in a sentence',
  'When do I use the present perfect?',
];

/** The turns worth sending: the tail, and never a half-finished reply. */
export function contextFor(messages, limit = HISTORY_LIMIT) {
  return messages
    .filter((m) => m.text && !m.pending)
    .slice(-limit)
    .map((m) => ({ role: m.role === 'you' ? 'user' : 'assistant', content: m.text }));
}

// ── reading the question, offline ──────────────────────────────────────────

const CLEAN = (s) => s.trim().replace(/^["'“”]|["'“”.?!]+$/g, '');

/**
 * Pull the word being asked about.
 *
 * Quoted words win — someone writing “resilient” means that word, whatever the
 * sentence around it. Otherwise match the shapes people actually type.
 */
export function subjectOf(question = '') {
  const quoted = question.match(/[“"']([a-zA-Z][a-zA-Z' -]{1,30})[”"']/);
  if (quoted) return CLEAN(quoted[1]).toLowerCase();

  const patterns = [
    /\bwhat (?:does|do) ([a-z][a-z'-]+) mean\b/i,
    /\bmeaning of ([a-z][a-z'-]+)/i,
    /\bdefine ([a-z][a-z'-]+)/i,
    /\bwhat is (?:an? )?([a-z][a-z'-]+)\??$/i,
    /\buse ([a-z][a-z'-]+) in a sentence/i,
    /\bexamples? (?:of|with) ([a-z][a-z'-]+)/i,
    /\bsynonyms? (?:of|for) ([a-z][a-z'-]+)/i,
  ];
  for (const re of patterns) {
    const hit = question.match(re);
    if (hit) return CLEAN(hit[1]).toLowerCase();
  }
  return null;
}

/** "X vs Y", "difference between X and Y". */
export function comparisonOf(question = '') {
  const patterns = [
    /difference between ([a-z][a-z'-]+) and ([a-z][a-z'-]+)/i,
    /\b([a-z][a-z'-]+) (?:vs\.?|versus) ([a-z][a-z'-]+)/i,
    /\b([a-z][a-z'-]+) or ([a-z][a-z'-]+)\s*\?/i,
  ];
  for (const re of patterns) {
    const hit = question.match(re);
    if (hit) return [CLEAN(hit[1]).toLowerCase(), CLEAN(hit[2]).toLowerCase()];
  }
  return null;
}

/** What the learner wants done with the word. */
export function intentOf(question = '') {
  if (/\bin a sentence\b|\bexamples?\b|\bhow (?:do|would) (?:i|you) use\b/i.test(question)) return 'usage';
  if (/\bsynonyms?\b|\banother word\b|\bsimilar\b/i.test(question)) return 'synonyms';
  return 'meaning';
}

// ── answering, offline ─────────────────────────────────────────────────────

/**
 * The built-in answer. Returns a string, or null when the question is outside
 * what the dictionary can settle — the caller then says so honestly.
 */
export async function localAnswer(question) {
  const pair = comparisonOf(question);
  if (pair) return compare(pair);

  const term = subjectOf(question);
  if (!term) return null;

  const entry = await Catalog.lookup(term).catch(() => null);
  if (!entry) {
    return `“${term}” is not in the built-in dictionary. Check the spelling, or turn on Claude in Settings and I can answer properly.`;
  }

  const intent = intentOf(question);
  const lines = [];

  if (intent === 'synonyms') {
    lines.push(entry.synonyms?.length
      ? `Close to “${term}”: ${entry.synonyms.slice(0, 6).join(', ')}.`
      : `The dictionary lists no synonyms for “${term}”.`);
    if (entry.definition) lines.push('', `It means: ${entry.definition}.`);
    return lines.join('\n');
  }

  if (intent === 'usage') {
    const examples = (entry.examples || []).filter(Boolean);
    if (examples.length) {
      lines.push(`“${term}” in use:`, ...examples.slice(0, 3).map((e) => `• ${e}`));
    } else {
      lines.push(`The dictionary has no example sentence for “${term}”, so here is what it means instead:`,
        `${entry.definition}.`);
      if (entry.pos) lines.push('', `It is ${article(entry.pos)} ${entry.pos}, so build the sentence around that.`);
      lines.push('', 'Write your own in Practise → Writing coach and it will be marked.');
    }
    return lines.join('\n');
  }

  lines.push(`${term}${entry.pos ? ` (${entry.pos})` : ''}`, entry.definition ? `${entry.definition}.` : '');
  if (entry.synonyms?.length) lines.push('', `Close in meaning: ${entry.synonyms.slice(0, 4).join(', ')}.`);
  if (entry.tr?.bn) lines.push(`Bangla: ${entry.tr.bn}`);
  return lines.filter(Boolean).join('\n');
}

/** Two words side by side, from their entries. */
async function compare([a, b]) {
  const [ea, eb] = await Promise.all([
    Catalog.lookup(a).catch(() => null),
    Catalog.lookup(b).catch(() => null),
  ]);
  if (!ea && !eb) {
    return `Neither “${a}” nor “${b}” is in the built-in dictionary. Turn on Claude in Settings for questions like this.`;
  }
  const lines = [];
  for (const [word, entry] of [[a, ea], [b, eb]]) {
    lines.push(entry
      ? `${word}${entry.pos ? ` (${entry.pos})` : ''} — ${entry.definition || 'no definition recorded'}.`
      : `${word} — not in the built-in dictionary.`);
  }
  if (ea && eb && ea.pos && eb.pos && ea.pos !== eb.pos) {
    lines.push('', `The clearest split is grammatical: one is ${article(ea.pos)} ${ea.pos}, the other ${article(eb.pos)} ${eb.pos}.`);
  }
  lines.push('', 'For how they differ in real use, turn on Claude in Settings — that is a question the dictionary alone cannot settle.');
  return lines.join('\n');
}

const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

/** What to say when the question is beyond the offline half. */
export const OFFLINE_MISS = [
  'That one needs Claude. The built-in tutor can define a word, compare two, list synonyms and show examples — all from the dictionary on your device — but an open question like this needs a model to answer it.',
  '',
  'Settings → AI help → Claude. Or ask me about a specific word and I will answer from the dictionary.',
].join('\n');
