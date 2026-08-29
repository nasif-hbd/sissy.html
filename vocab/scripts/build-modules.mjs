#!/usr/bin/env node
/**
 * Turns the sectioned vocabulary workbook into what the app actually ships:
 *
 *   data/modules/index.json   the module manifest the Modules tab lists
 *   data/modules/<id>.json    one pack per module, fetched when opened
 *   data/dict/<a-z>.json      the whole dataset, sharded by first letter,
 *                             so adding a word is an offline lookup rather
 *                             than an API call
 *
 *   node scripts/build-modules.mjs path/to/word_meanings_SECTIONED.xlsx
 *
 * Nothing here is hand-maintained afterwards: re-run it and the packs are
 * rebuilt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readWorkbook } from './xlsx.mjs';
import { sameFamily } from './family.mjs';

const SRC = process.argv[2];
if (!SRC) { console.error('usage: build-modules.mjs <word_meanings_SECTIONED.xlsx>'); process.exit(1); }

const OUT_MODULES = 'data/modules';
const OUT_DICT = 'data/dict';
const TARGET = Number(process.env.MODULE_SIZE || 400);

/* ===========================================================================
   The sections

   Both of the things a pack is built from used to be guesses. Difficulty came
   from a column that cut the old CSV into four equal quarters, and exam
   membership from keyword rules run over the definition — which is how a
   Grade 1–5 pack ended up holding "terrorist" and "acrobatics".

   This workbook states both outright. Four sheets partition every word by how
   hard it is; five more mark what a word is studied for. So neither is
   inferred any more: the tier sheet sets the band, and the subject sheets
   decide who is on which list.
=========================================================================== */
const TIERS = {
  NORMAL: 'Easy', INTERMEDIATE: 'Moderate', ELITE: 'Advanced', EXCEPTIONAL: 'God Level',
};
/** Subject sheets, in no particular order — a word may sit on several. */
const SECTIONS = ['ACADEMICS', 'IELTS', 'SAT', 'BD_ADMISSION_TEST', 'JOB'];

const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();

/* ===========================================================================
   Cleaning

   Every rule below exists because the raw data measurably needed it. Counts
   are tallied into `report` and written out with the packs, so the filtering
   is auditable rather than a matter of trust.
=========================================================================== */
const report = { rows: 0, kept: 0, rejected: {}, repaired: {}, harvested: {} };
const reject = (rule) => { report.rejected[rule] = (report.rejected[rule] || 0) + 1; return false; };
const repaired = (rule) => { report.repaired[rule] = (report.repaired[rule] || 0) + 1; };
const harvested = (rule) => { report.harvested[rule] = (report.harvested[rule] || 0) + 1; };

/** Words a vocabulary app aimed at students should not be teaching. */
const EXPLICIT = /\b(contraceptive|condom|sexual intercourse|copulat\w*|masturbat\w*|genitalia|erotic|pornograph\w*)\b/i;
const BLOCKED = /\b(ass|asshole|arse|bastard|bitch|bollocks|bugger|cock|crap|cunt|dick|dildo|dyke|fag|faggot|fuck|jism|jizz|nigger|penis|piss|prick|prostitute|pussy|queer|semen|shit|slut|spic|tits|turd|twat|vagina|wanker|whore|wop)\b/i;

/**
 * Rows whose "definition" describes something other than the ordinary word.
 *
 * The workbook carries one sense per headword, and for a handful of common
 * words that sense is a slang list or a proper noun: "grass — street names for
 * marijuana", "far — a terrorist organization that seeks to overthrow the
 * government dominated by Tutsi". There is no better sense in the data to fall
 * back to, so the entry goes rather than teach that one.
 */
const NOT_A_SENSE = /^street names? for\b|\b(terrorist organization|guerrilla group|militant group|paramilitary organization)\b/i;

const TAXONOMIC = /\b(genus|subgenus|family|subfamily|superfamily|order|suborder|phylum|class|tribe|any of (?:various|numerous|several)|type genus|widely distributed|native to|deciduous|evergreen|perennial|annual herb|shrubs?|herbs?|mollusks?|arthropods?|beetles?|moths?|orchids?|ferns?|grasses)\b/i;
const CITATION = /[;,]?\s*[-–—]{1,2}\s*[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2}\s*$/;  // "; --Hippocrates"
/* Any leading bracketed label — a register note like "(informal)", a domain
   like "(law)", a scope like "(of handwriting)". A definition almost never
   opens with a parenthetical that carries the meaning itself. */
const LEAD_NOTE = /^\([^)]{1,70}\)[\s,:-]*/;

/**
 * Tidy one definition, and hand back any usage example hiding inside it.
 *
 * 12,253 rows carry "definition; an example using the word" in a single field.
 * That trailing clause is worth more as an example sentence than as definition
 * noise, so it is lifted out rather than discarded.
 */
function cleanDefinition(rawDef, word) {
  let d = squash(rawDef);
  if (!d) return null;

  if (CITATION.test(d)) { d = d.replace(CITATION, ''); repaired('citation removed'); }
  if (/`/.test(d)) { d = d.replace(/`([^']*)'/g, '“$1”').replace(/`/g, '‘'); repaired('backtick quotes'); }
  if (/;\s*;/.test(d)) { d = d.replace(/(?:\s*;)+/g, ';'); repaired('empty semicolon runs'); }

  // Strip the note whatever is left behind — "not legible" is a fine
  // definition, and the too-short rule catches anything that isn't.
  const lead = d.match(LEAD_NOTE);
  if (lead && d.length > lead[0].length) { d = d.slice(lead[0].length); repaired('leading note stripped'); }

  // Split off trailing clauses; any clause that uses the word is an example.
  const stem = word.replace(/(?:e?s|ed|ing|ly)$/, '');
  const uses = (t) => stem.length > 2 && new RegExp(`\\b${stem}`, 'i').test(t);
  const parts = d.split(/\s*;\s*/).map(squash).filter(Boolean);

  const defParts = [];
  const examples = [];
  for (const part of parts) {
    if (/^[-–—]{1,2}\s*[A-Z]/.test(part)) { repaired('citation removed'); continue; }
    if (defParts.length && uses(part) && part.split(' ').length >= 4) {
      examples.push(part.replace(/^["“]|["”]$/g, ''));
      harvested('example sentence');
    } else if (defParts.length < 2 && !uses(part)) {
      defParts.push(part);
    }
  }

  d = defParts.join('; ').replace(/^[,;:\s]+|[,;:\s]+$/g, '');
  if (d.length > 180) {                       // cut on a word, never mid-word
    d = d.slice(0, 180).replace(/\s+\S*$/, '') + '…';
    repaired('long definition trimmed');
  }
  return { definition: d, examples: examples.slice(0, 2) };
}

/** Scripts each translation column must actually be written in. */
const SCRIPTS = { bn: /[ঀ-৿]/, hi: /[ऀ-ॿ]/, zh: /[一-鿿]/ };

function cleanTranslation(value, script) {
  const t = squash(value);
  if (!t || t === 'undefined' || t.length < 2 || /^[\^\-_.]+$/.test(t)) return '';
  if (!SCRIPTS[script].test(t)) { repaired(`${script}: not in script`); return ''; }
  return t.replace(/\s*[;,/]\s*/g, ' / ').slice(0, 60);
}

function cleanSynonyms(list, word) {
  const out = [];
  for (const raw of list) {
    const s = squash(raw).toLowerCase();
    if (!s || s === word) continue;
    if (s.split(' ').length > 3) continue;         // phrases stop being useful
    if (s.includes(word) || word.includes(s)) continue;   // same lemma
    if (BLOCKED.test(s)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 4);
}

/* ===========================================================================
   Reading the workbook

   The tier sheets partition the vocabulary, so one pass over them collects
   every word exactly once and settles its band. The subject sheets then only
   add labels: their rows are byte-identical to the tier row for the same word,
   so there is nothing else in them to keep.
=========================================================================== */
const book = readWorkbook(SRC);
for (const sheet of [...Object.keys(TIERS), ...SECTIONS]) {
  if (!book.sheets.includes(sheet)) {
    console.error(`workbook has no "${sheet}" sheet; it has: ${book.sheets.join(', ')}`);
    process.exit(1);
  }
}

const sheetRows = new Map();
for (const [sheet, band] of Object.entries(TIERS)) {
  let n = 0;
  for (const row of book.records(sheet)) {
    const w = squash(row.word).toLowerCase();
    if (!w || sheetRows.has(w)) continue;
    sheetRows.set(w, { row, x: band, sec: [] });
    n += 1;
  }
  console.log(`  ${sheet.padEnd(13)} ${String(n).padStart(6)} words → ${band}`);
}
for (const sheet of SECTIONS) {
  let n = 0, orphans = 0;
  for (const row of book.records(sheet)) {
    const w = squash(row.word).toLowerCase();
    if (!w) continue;
    // A word outside every tier sheet would be a re-export that dropped it;
    // keep it rather than lose the subject, at the middle band.
    if (!sheetRows.has(w)) { sheetRows.set(w, { row, x: 'Moderate', sec: [] }); orphans += 1; }
    const held = sheetRows.get(w);
    if (!held.sec.includes(sheet)) { held.sec.push(sheet); n += 1; }
  }
  console.log(`  ${sheet.padEnd(13)} ${String(n).padStart(6)} tagged${orphans ? ` (${orphans} outside every tier)` : ''}`);
}

const records = [...sheetRows].map(([word, { row, x, sec }]) => {
  report.rows += 1;
  const cleaned = cleanDefinition(row.english_meaning, word);
  return {
    w: word,
    p: squash(row.part_of_speech).toLowerCase(),
    d: cleaned?.definition || '',
    e: cleaned?.examples || [],
    s: cleanSynonyms([1, 2, 3, 4, 5].map((n) => row[`synonym_${n}`] || ''), word),
    bn: cleanTranslation(row.bangla_meaning, 'bn'),
    hi: cleanTranslation(row.hindi_meaning, 'hi'),
    zh: cleanTranslation(row.chinese_simplified, 'zh'),
    x,
    sec,
  };
});

// The tier sheets are disjoint and each lists a headword once, so this is
// already one entry per word; the map is for lookup, not de-duplication.
const byWord = new Map(records.map((r) => [r.w, r]));
console.log(`\n${byWord.size} headwords read`);

/** Is this word on a subject list? */
const on = (r, sheet) => r.sec.includes(sheet);

/* ===========================================================================
   What is worth teaching

   Rejection is deliberately loud: each rule is counted, so a bad rule shows up
   as an implausible number rather than as words quietly going missing.
=========================================================================== */
function teachable(r) {
  if (!/^[a-z][a-z'-]{2,15}$/.test(r.w)) return reject('headword not a plain word');
  if (/--|''/.test(r.w)) return reject('headword malformed');
  if (BLOCKED.test(r.w)) return reject('blocked term');
  if (!r.d) return reject('no definition after cleaning');
  if (r.d.length < 12) return reject('definition too short');
  if (BLOCKED.test(r.d) || EXPLICIT.test(r.d)) return reject('blocked in definition');
  if (TAXONOMIC.test(r.d)) return reject('taxonomic entry');
  if (NOT_A_SENSE.test(r.d)) return reject('not a sense of the word');
  if (!r.p) return reject('no part of speech');

  // Circular only when the word carries the definition. "exempt: grant
  // exemption or release to" leaves nothing once its own lemma is removed;
  // "validate: declare or make legally valid" still says something, and
  // rejecting that kind of entry threw away thousands of good words.
  if (isCircular(r)) return reject('circular definition');

  return true;
}

const STOPWORDS = new Set(['that', 'with', 'from', 'this', 'they', 'them', 'their', 'have',
  'been', 'being', 'which', 'when', 'what', 'used', 'especially', 'something', 'someone',
  'having', 'other', 'into', 'than', 'also', 'such', 'more', 'most', 'able']);

/**
 * Circular only if the headword's own lemma appears AND little else does.
 * A short definition is not the same thing as a circular one: "abolish — do
 * away with" says plenty and never mentions abolish.
 */
function isCircular(r) {
  // Two thirds of the word, not all-but-two: "cohesive" has to match
  // "cohesion", which slicing at length-2 never would.
  const lemma = r.w.slice(0, Math.max(4, Math.ceil(r.w.length * 0.62)));
  const tokens = r.d.toLowerCase().match(/[a-z]{3,}/g) || [];
  if (!tokens.some((t) => t.startsWith(lemma))) return false;
  const kept = tokens.filter((t) => !t.startsWith(lemma) && !STOPWORDS.has(t));
  return kept.length < 3;
}

/**
 * Inflections of a word already in the pool are dead weight in a study pack —
 * "belated" stays, but "abolished" goes when "abolish" is present.
 */
function isInflectionOfPool(r, pool) {
  const m = r.w.match(/^(.+?)(ed|ing|es|s)$/);
  if (!m) return false;
  const [, root, suffix] = m;
  const candidates = [root, root + 'e', root.replace(/([bcdfghjklmnpqrstvwxz])\1$/, '$1')];
  for (const base of candidates) {
    if (base.length < 3 || base === r.w) continue;
    const parent = pool.get(base);
    if (!parent) continue;
    // only when they clearly share a sense
    const words = (t) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) || []);
    const a = words(r.d), b = words(parent.d);
    const overlap = [...a].filter((w) => b.has(w)).length;
    if (overlap >= 2 || r.d === parent.d) return true;
    if (suffix === 's' && overlap >= 1) return true;
  }
  return false;
}

const teachablePool = [...byWord.values()].filter(teachable);
const poolIndex = new Map(teachablePool.map((r) => [r.w, r]));
const pool = teachablePool.filter((r) => {
  if (isInflectionOfPool(r, poolIndex)) return reject('inflection of a word already present');
  return true;
});
report.kept = pool.length;
console.log(`${pool.length} teachable entries (from ${byWord.size})`);

/* ===========================================================================
   Centrality as a frequency proxy

   There is no frequency column, but there is a synonym graph: a word listed as
   a synonym by many other entries is a central, ordinary word, and one nobody
   points at is peripheral. That in-degree is the closest thing the data has to
   a frequency list, and it is what separates "Native & Everyday" from "Elite".
=========================================================================== */
const degree = new Map();
for (const r of byWord.values()) {
  for (const s of r.s) degree.set(s, (degree.get(s) || 0) + 1);
}
const central = (w) => degree.get(w) || 0;
const degrees = [...pool].map((r) => central(r.w)).sort((a, b) => a - b);
const p = (q) => degrees[Math.floor(degrees.length * q)];
console.log(`synonym centrality: median ${p(0.5)}, 90th ${p(0.9)}, max ${degrees.at(-1)}`);

/**
 * "issuing" when "issue" exists, "varied" when "vary" does.
 *
 * ACADEMICS lists whole word families, so a pack that runs out of headwords
 * starts serving their inflections. Ranking them down puts the base form first
 * and leaves the inflection for the space nothing better fills.
 */
function looksInflected(r) {
  const m = r.w.match(/^(.+?)(ed|ing|es|s|ly|d)$/);
  if (!m) return false;
  const [, root] = m;
  return [root, `${root}e`, `${root}y`].some((base) => base !== r.w && base.length > 2 && byWord.has(base));
}

/**
 * "slingshot", "soundproof", "springtime" — two ordinary words stuck together.
 *
 * Nothing points at them as a synonym, so by rarity alone they looked like the
 * rarest words in the language, and they filled the back of the Elite pack.
 * Cutting them at every point and asking whether both halves are words of their
 * own is what separates them from "supercilious".
 */
function compound(w) {
  for (let i = 4; i <= w.length - 4; i++) {
    if (byWord.has(w.slice(0, i)) && byWord.has(w.slice(i))) return true;
  }
  return false;
}

/** Higher is more worth a learner's time. */
function score(r) {
  let n = 0;
  n += Math.min(r.s.length, 3) * 2;
  n += Math.min(central(r.w), 6);              // how central the word is
  n += r.e.length * 3;                          // a real usage example is gold
  n += r.bn ? 3 : 0;
  n += r.hi ? 2 : 0;
  n += r.zh ? 1 : 0;
  n += r.w.length >= 5 && r.w.length <= 12 ? 2 : 0;
  if (r.d.length > 30 && r.d.length < 130) n += 1;
  if (looksInflected(r)) n -= 8;
  return n;
}

// ── the modules ───────────────────────────────────────────────────────────
// A pack is built in three passes. `core` is the subject sheet it is named
// after — the workbook's own answer to what is on this list. `seeds` is a
// curated list, for the packs where a person knows something the sheet does
// not. `want` decides which of the remaining entries may top it up to TARGET.
const seeds = (s) => s.trim().split(/\s+/);

/**
 * School-level packs.
 *
 * The workbook has no grade column either, but it does have the two things a
 * grade actually depends on: how hard a word is, stated by which tier sheet it
 * sits on, and whether it is academic, stated by the ACADEMICS sheet. Synonym
 * centrality and length only break the remaining ties, shortest first, because
 * short words are learned first in every language.
 *
 * `cap` keeps a pack from drifting upward: without it the scorer, which rewards
 * synonyms and translations, fills a Grade 1–5 pack with well-documented long
 * words nobody teaches a seven-year-old.
 */
/**
 * Junk that survives the general cleaning but must never reach a school pack.
 *
 * The upper packs sit at low centrality, where the workbook's tail lives: roman
 * numerals, initialisms, transliterated place names and slang all look like
 * ordinary short words to a filter that only checks a-z. Grade 9–10 came back
 * holding "xii", "nsu", "blah" and "uzbeg" before this existed.
 */
const ROMAN = /^(?=[mdclxvi]+$)m*(c[md]|d?c{0,3})(x[cl]|l?x{0,3})(i[xv]|v?i{0,3})$/;
/* Subjects that belong in a classroom conversation rather than on a word list a
   child is handed to memorise. The general BLOCKED rule is about language; this
   is about topic, and applies to the school packs only — "terrorist" and
   "bondage" both reached Grade 9–10 on merit before it existed.

   Two regexes, not one, because a definition is not a headword: "terrible —
   causing fear or dread or terror" and "child — a young person of either sex"
   are exactly what a school pack wants, and a single rule loses both. */
const ADULT_WORD = /^(sex|sexes|sexy|sexual|sexuality|erotic|erotica|porn|pornography|bondage|fetish|rape|incest|prostitute|prostitution|brothel|terror|terrorist|terrorism|suicide|murder|murderer|massacre|genocide|torture|narcotic|narcotics|heroin|cocaine|opium|marijuana|cannabis|addict|molest|obscene)$/i;
const ADULT_SENSE = /\b(sexual\w*|sexuality|erotic\w*|porn\w*|bondage|fetish|incest|prostitut\w*|brothel|marijuana|cannabis|cocaine|heroin|narcotics?|opium)\b/i;
/** The topic rule. Every word in a school pack passes it, curated or not. */
const schoolTopic = (r) => !ADULT_WORD.test(r.w) && !ADULT_SENSE.test(r.d);

/* The rest are quality rules for words the scorer picked rather than a person,
   so they are the tail's problem and not a curated list's: holding "banana",
   "milk" and "moon" to a 20-character definition emptied Grade 1–5. */
const schoolSafe = (r, minLen) =>
  schoolTopic(r)
  && r.w.length >= minLen
  && /^[a-z]+$/.test(r.w)
  && !ROMAN.test(r.w)
  && /[aeiouy]/.test(r.w)                      // an initialism has no vowel run
  && !/^[bcdfghjklmnpqrstvwxz]{3}/.test(r.w)   // nsu, pbs, cxl…
  && /^(noun|verb|adjective|adverb)$/.test(r.p)
  && r.d.length >= 20 && r.d.length <= 140
  && !/\b(city|town|province|county|capital|river|island|dynasty|deity|genus|surname|a state|a region)\b/i.test(r.d);

const gradePack = ({ id, title, blurb, level, bands, minCentral, maxCentral,
                     cap, minLen = 3, seeds: curated = [], academic = false,
                     section, prefer }) => ({
  group: 'School', id, title, blurb, level,
  seeds: curated,
  /* Seeds used to skip every school rule, which is how "smoke — street names
     for marijuana" reached Grade 1–5: it is a fine word to teach, but not with
     the only sense the workbook has for it. */
  allow: schoolTopic,
  /* A pack named after a subject sheet takes that sheet as its list — but only
     its own slice of it. ACADEMICS spans every tier, and without the band check
     the University pack simply repeated Grade 9–10 word for word. */
  core: section
    ? (r) => on(r, section) && bands.includes(r.x) && schoolSafe(r, minLen)
      && (!academic || r.s.length >= 1)
    : undefined,
  want: (r) => bands.includes(r.x)
    && central(r.w) >= minCentral
    && (maxCentral === undefined || central(r.w) <= maxCentral)
    && r.w.length <= cap
    && schoolSafe(r, minLen)
    // A word worth teaching at any level has at least one synonym recorded;
    // the tail of the dataset is mostly entries with none.
    && (!academic || r.s.length >= 1),
  /**
   * School packs rank by simplicity, not by how well documented a word is.
   *
   * The default scorer rewards synonyms, translations and examples, which are
   * properties of a good dictionary entry rather than of an easy word — left to
   * it, Grade 1–5 filled up with "terrorist", "admonition" and "acrobatics".
   * Centrality first, then brevity: the words other entries keep pointing at,
   * shortest first.
   */
  /**
   * Lower packs rank by simplicity; upper packs by the default scorer, nudged
   * toward whichever subject sheet the pack is aiming at.
   *
   * Preferring short words is right for a seven-year-old and wrong for a
   * university list, where it just surfaces the shortest obscure entries. Above
   * Grade 8 a word on the academic list — or failing that a well-documented one
   * — is the better bet.
   */
  rank: academic
    ? (r) => score(r) + [prefer].flat().filter(Boolean).filter((s) => on(r, s)).length * 40
    : (r) => central(r.w) * 4 - r.w.length * 2 - Math.floor(r.d.length / 20),
});

const MODULES = [
  gradePack({
    id: 'grade-1-5', title: 'Grade 1–5', level: 'A1–A2', cap: 8,
    blurb: 'The first few thousand words: short, everyday, and the ones everything else is built on.',
    bands: ['Easy'], minCentral: 5,
    // Primary-school vocabulary is a known list, not something to infer. These
    // are the concrete nouns, plain verbs and basic adjectives a child meets
    // first; the top-up only fills what the core leaves.
    seeds: seeds(`
      able above afraid after again against alone along already always angry animal answer
      apple arm around arrive ask asleep aunt away baby back bad bag ball banana basket bath
      beach bear beautiful because bed bee before begin behind bell below beside best better
      between big bird birthday black blue boat body bone book boot bottle bowl box boy branch
      brave bread break breakfast bridge bright bring brother brown brush build burn bus busy
      butter button buy cake call camera candle cap car card care careful carry cat catch chair
      chalk cheap cheese chicken child chin city clap class clean clear climb clock close cloth
      cloud coat cold colour comb come cook cool copy corner cost count country cover cow crayon
      cry cup cut dance dark daughter day dear deep desk dinner dirty dish doctor dog doll door
      down draw dream dress drink drive drop dry duck each ear early earth east easy eat egg
      eight elbow empty end enough enter evening every eye face fall family famous fan far farm
      fast fat father feed feel fence field fight fill find finger finish fire first fish five
      fix flag floor flower fly follow food foot forest forget fork four fox free fresh friend
      frog front fruit full fun game garden gate gift girl give glad glass glove goat gold good
      grass great green grow guess hair half hand happy hard hat head hear heart heavy help
      hide high hill hold hole home honey hope horse hot hour house hungry hurry hurt ice idea
      important inside iron island jump keep key kick kind king kitchen knee knife knock know
      ladder lake lamp land large last late laugh lazy leaf learn leave left leg lemon lesson
      letter lie life light like line lion lip listen little live long look lose loud love
      lunch make man many map mark market meal mean meat meet melt milk mind minute mirror miss
      mistake mix money monkey month moon morning mother mountain mouse mouth move much music
      name near neck need needle nest never new news next nice night nine noise north nose note
      now number nurse ocean office often oil old once onion only open orange order other out
      outside over paint pair paper parent park part pass pen pencil people pick picture piece
      pig pink place plane plant plate play please pocket point poor pot potato pour present
      press pretty price prize proud pull push put queen question quick quiet rabbit rain read
      ready red rest rich ride right ring river road rock roof room root rope round rule run
      sad safe salt same sand save say school sea seat second see seed sell send seven shake
      shape sheep shelf shine ship shirt shoe shop short shoulder shout show shut sick side
      sign silver sing sister sit six skin sky sleep slow small smell smile smoke snake snow
      soap sock soft some son song soon sorry sound soup south speak spell spend spoon spring
      square stamp stand star start stay step stick stone stop store storm story straight
      street strong study sugar summer sun sweet swim table tail take talk tall taste teach
      team tear teeth tell ten thank thick thin thing think third thirsty three throw thumb
      tiger time tired today toe together tomato tomorrow tonight tooth top touch towel town
      toy train travel tree true try turn twelve twenty two ugly uncle under until use usual
      very village visit voice wait wake walk wall want warm wash watch water wave weak wear
      week west wet wheel when where white whole why wide wife wild win wind window wing winter
      wise wish woman wood wool word work world write wrong yard year yellow yes yesterday
      young zero
    `),
  }),
  gradePack({
    id: 'grade-6-8', title: 'Grade 6–8', level: 'A2–B1', cap: 11,
    blurb: 'Middle-school English — longer words, and the first abstract ones.',
    bands: ['Easy', 'Moderate'], minCentral: 3, maxCentral: 20,
    seeds: seeds(`
      ability absent accept accident account achieve active actual admire admit advance
      adventure advice affect afford agree ahead aim allow alone amount ancient announce annual
      anxious apart apology appear apply approach argue arrange arrive article artist ashamed
      assist assume attach attack attempt attend attention attract average avoid aware balance
      basic battle behave belief benefit blame border borrow bother brain branch brief brilliant
      broad bury cancel capable capture careless cause ceiling celebrate central century certain
      challenge champion character charge cheerful choice citizen claim clever climate collect
      combine comfort command comment common compare compete complain complete concern condition
      confident confuse connect consider constant contain continue control convince courage
      create crime crowd cruel culture curious current custom damage danger decide declare
      decrease defend degree delay delight deliver demand deny depend describe desert deserve
      design desire destroy detail develop device difference difficult direct disagree disappear
      discover discuss disease distance disturb divide double doubt dozen drift drown eager
      earn edge effect effort elect else emotion employ empty encourage energy engine enormous
      entire envy equal escape essential establish event evidence exact examine example excite
      excuse exercise exist expand expect expense experience explain explore express extra
      failure faith familiar fault favour fear feature fever figure final flavour float flood
      focus force forgive formal fortune forward frequent friendly frighten further gather
      general generous gentle gesture giant glance global goal govern gradual grateful greedy
      guard guess guide habit handle happen harbour harm health honest honour horrible however
      huge human humour hunt ignore illness image imagine immediate import impress improve
      include increase indeed indicate industry influence inform injure innocent insect insist
      inspect instant instead intend interest introduce invent invite involve iron island issue
      journey judge justice knowledge labour lack language later lately lead leak legal leisure
      level limit local locate lonely loose lower loyal luck luggage machine magic maintain
      major manage manner material matter measure medicine member memory mention mercy message
      metal method middle mild military modern moment monitor mood moral motion movement muscle
      narrow nation native nature nearby neat necessary neglect neighbour nervous neutral noble
      normal notice nowhere obey object observe obtain obvious occasion occupy occur offer
      official operate opinion oppose option ordinary organise origin owe pack pain palace panic
      parcel particular partner passage patient pattern pause peace perform perhaps period
      permit person persuade physical pity plain pleasant plenty poison polite pollute popular
      portion position possess possible pour poverty powder power practical praise prefer
      prepare present prevent previous private prize probable problem produce profit progress
      promise proper propose protect proud provide public punish purchase purpose quality
      quantity quarrel quarter rapid rare reach realise reason receive recent recognise record
      recover reduce refer reflect refuse regard region regret regular reject relate relax
      release relief remain remark remind remove repair repeat replace reply report represent
      request require rescue research reserve resist respect respond result retire return
      reveal reward risk rough route royal rubbish rural sacrifice satisfy scarce scatter scene
      schedule scheme science search secret section secure select sense sensible separate
      series serious servant service settle severe shallow shame share shelter shift shock
      shortage sight signal silence similar simple sincere single situation skill slight
      society soil solid solve sorrow source spare special specific spectacle spirit spoil
      spread stable staff standard state steady steep stiff store storm strange stranger
      strength stress stretch strict struggle stubborn subject succeed sudden suffer suggest
      suitable summary supply support suppose surface surround survive suspect swallow sweep
      switch symbol system talent target task temper temporary tend tension terrible thorough
      threat thrill tidy tight tiny tool total tough trade tradition traffic transfer translate
      transport trap treasure treat trial trouble trust truth typical unable unique unite
      universe unusual upset urgent useful usual vacant vain valley valuable variety various
      vast vehicle victory view violent virtue visible vision volume voyage wander warn waste
      weapon weather weigh welcome whole wisdom witness wonder worth wound wrap
    `),
  }),
  /* Grade 9–10 upward is the academic word list, split by tier: the ACADEMICS
     sheet holds every word school and university reading assumes, and which
     tier a word sits on is how hard it is. So the three packs take one slice
     each — everyday-and-common, advanced, rare — and no word appears twice. */
  gradePack({
    id: 'grade-9-10', title: 'Grade 9–10', level: 'B1–B2', cap: 12, minLen: 5,
    blurb: 'The vocabulary secondary-school reading and writing starts to assume.',
    bands: ['Easy', 'Moderate'], minCentral: 1, academic: true,
    section: 'ACADEMICS', prefer: 'ACADEMICS',
  }),
  gradePack({
    id: 'grade-11-12', title: 'Grade 11–12', level: 'B2–C1', cap: 14, minLen: 6,
    blurb: 'Higher-secondary English: argument, analysis and the words essays need.',
    bands: ['Advanced'], minCentral: 0, academic: true,
    section: 'ACADEMICS', prefer: ['ACADEMICS', 'IELTS', 'SAT'],
  }),
  gradePack({
    id: 'university', title: 'University', level: 'C1–C2', cap: 18, minLen: 6,
    blurb: 'Academic register — the words lectures, papers and seminars run on.',
    bands: ['God Level'], minCentral: 0, academic: true,
    section: 'ACADEMICS', prefer: ['ACADEMICS', 'IELTS', 'SAT'],
  }),
  {
    group: 'Exams', id: 'ielts-gt', title: 'IELTS General Training',
    blurb: 'The everyday and workplace English GT tests, rather than the academic register of Academic.',
    level: 'B1–B2',
    seeds: seeds(`
      accommodation advertise apply appointment arrange assist attend available bill book
      borrow budget cancel charge cheque colleague community commute complain confirm contact
      convenient council customer delay deliver deposit discount enquire equipment estimate
      expense facility flatmate furnish guarantee hire household inconvenience insurance
      invoice landlord lease leisure maintenance neighbour notice occupation overtime parcel
      permit postpone premises queue receipt recommend refund register reliable rent repair
      reserve resident retail routine schedule shift staff subscription supervisor supply
      tenant timetable transfer utility vacancy volunteer wage warranty workplace
    `),
    // GT is the IELTS list minus its academic half — the everyday and workplace
    // end, which is what the paper actually tests.
    want: (r) => on(r, 'IELTS') && !on(r, 'ACADEMICS') && ['Easy', 'Moderate'].includes(r.x),
  },
  {
    group: 'Exams', id: 'ielts', title: 'IELTS', blurb: 'Academic vocabulary that carries marks in Writing Task 2 and Reading.',
    level: 'B2–C1',
    seeds: seeds(`
      analyse approach area assess assume authority available benefit concept consist context contract
      create data define derive distribute economy environment establish estimate evident export factor
      finance formula function identify income indicate individual interpret involve issue labour legal
      legislate major method occur percent period policy principle proceed process require research
      respond role section sector significant similar source specific structure theory vary
      alternative circumstance considerable constitute convene coordinate document dominate emphasis
      ensure exclude framework implement implicate impose integrate justify maintain normal obtain
      participate perceive positive potential previous primary purchase range region regulate relevant
      reside resource restrict secure seek select site strategy survey text tradition transfer
      acknowledge accumulate adjacent ambiguous coherent commodity compile conform deviate diminish
      empirical explicit facilitate fluctuate hierarchy hypothesis inevitable infer inherent innovate
      integral intervene mediate mutual notion nonetheless paradigm phenomenon plausible practitioner
      predominant preliminary presume prohibit protocol qualitative rational refine reinforce
      subsequent substitute sustain thereby underlie undertake validate whereas widespread
    `),
    want: (r) => on(r, 'IELTS') && /^(noun|verb|adjective)$/.test(r.p),
    // Academic first: the half of the IELTS list that carries Task 2 marks.
    rank: (r) => score(r) + (on(r, 'ACADEMICS') ? 40 : 0),
  },
  {
    group: 'Exams', id: 'sat', title: 'SAT', blurb: 'The judgement-and-degree words American college tests keep coming back to.',
    level: 'C1',
    seeds: seeds(`
      abate aberrant abstain adulterate advocate aesthetic amalgamate ambivalent ameliorate anachronism
      analogous anomaly antagonize apathy appease arbitrary arduous articulate ascetic assiduous
      audacious austere autonomous banal belie benevolent bolster bombastic cacophony candid capricious
      castigate catalyst caustic censure chicanery coalesce cogent commensurate complacent conciliatory
      condone connoisseur contentious contrite conundrum convoluted copious corroborate credulous
      cryptic culpable cursory debunk decorum deference deleterious deride derivative desiccate
      despondent diatribe didactic diffident digression dilatory diligent discern discordant discrete
      disdain disparage disparate dissemble disseminate dogmatic dubious ebullient eclectic efficacy
      egregious elicit eloquent elusive embellish empirical emulate enervate engender enigma ephemeral
      equivocate erudite esoteric eulogy euphemism exacerbate exculpate exemplary exhaustive exonerate
      expedient extol extraneous fastidious fatuous fervent flout foment frugal futile garrulous
      grandiose gregarious hackneyed harangue haughty hedonist heresy iconoclast idiosyncrasy immutable
      impartial impede impetuous implacable inadvertent incisive incongruous indifferent indolent
      ineffable inept inexorable ingenuous inherent innocuous insipid insular intransigent intrepid
      inundate irascible laconic lament languid laud lethargic loquacious lucid magnanimous malleable
      meticulous mitigate mollify morose mundane nefarious nonchalant nostalgia obfuscate obsequious
      obstinate officious onerous opaque opulent ostentatious paradox partisan paucity pedantic
      penchant perfunctory pernicious perturb pervasive petulant philanthropy pinnacle placate
      plausible plethora poignant pragmatic precipitate preclude presumptuous pretentious prodigal
      profound prolific propensity prosaic pundit quandary quixotic rancor rebuke recalcitrant
      reciprocate reclusive redundant refute relegate relinquish remorse reproach repudiate resilient
      reticent reverence rhetoric sagacious salient sanction satiate scrutinize serene skeptic
      solicitous soporific spurious squander stagnant staid stoic strident subtle succinct superfluous
      surreptitious sycophant tacit tangential tenacious tenuous terse timorous tirade torpor tractable
      transient trepidation trite truculent ubiquitous unequivocal unprecedented untenable urbane
      vacillate venerate veracity verbose vex vigilant vilify vindicate virulent vociferous volatile
      wary whimsical zealous
    `),
    want: (r) => on(r, 'SAT') && /^(adjective|verb|noun)$/.test(r.p),
  },
  {
    group: 'Exams', id: 'admission-bd', title: 'Admission (BD)', blurb: 'Synonym-and-antonym drilling for Bangladeshi university admission tests.',
    level: 'B2–C1',
    // The workbook's own admission list leads; the curated synonym-and-antonym
    // words below fill the rest, since the sheet is smaller than a pack.
    core: (r) => on(r, 'BD_ADMISSION_TEST'),
    seeds: seeds(`
      abolish abundant accelerate accord acute adamant adverse affable affluent alleviate allude aloof
      amiable ample annul apprehend arrogant astute augment authentic aversion belated benign brittle
      callous candid coerce cohesive commence compel compile comply concise condemn confine conspicuous
      contempt convey cordial covet curtail deceive decline deficit deform delude demolish denounce
      deplete deprive despise deter deteriorate detrimental devise diligent discard disperse dissent
      diverse docile dubious eloquent embark eminent endorse enhance enormous eradicate erratic
      essential evade exempt exhaust exotic expedite exquisite extinct fabricate feeble ferocious
      fertile flourish fragile frank furnish futile generous genuine gigantic glimpse gorgeous grief
      hamper hazard hinder hostile humble idle ignite illegible immense impair impartial impede
      imperative impose incentive indigenous inevitable infamous inflict ingenious inherit initiate
      innate innocent insist intact intense intricate intrigue invade jeopardy jubilant keen lament
      lavish legible lenient liable linger lucid lucrative magnify malice mandatory meager mediocre
      menace merge migrate mock modest momentum monotonous naive negligent notorious noxious obese
      obscure obsolete obstinate offend ominous optimum outrage overwhelm pacify paralyse peculiar
      perilous perish permanent perpetual persist pertinent pessimist plungeポ postpone precise
      prejudice prevail primitive proclaim prominent prompt prone prosper provoke prudent punctual
      quench radiant rebel recede reckless reconcile redundant refrain refute reluctant remedy
      remarkable render renowned repel reproach resent resign resolve restrain retain reveal revive
      rigid ruthless sacred scarce scatter scorn secure serene severe shabby shrewd sincere slender
      sober solitary sombre sophisticated sparse spontaneous sturdy submit subtle summon superb
      surpass suspend sustain swift tedious temporary tempt tenant tender thorough thrive timid
      tolerate tranquil transparent tremendous trivial turmoil unanimous uniform unite urge utmost
      vacant vague valiant vanish vast vehement venture verdict vibrant vicious vigilant vigour
      vivid vulgar vulnerable wander wary weary withstand wretched yield zeal
    `),
    want: (r) => r.s.length >= 2 && ['Advanced', 'Moderate'].includes(r.x),
  },
  {
    group: 'Work & life', id: 'job', title: 'Job & Workplace', blurb: 'Interviews, email, contracts and the language of getting things done.',
    level: 'B1–C1',
    core: (r) => on(r, 'JOB'),
    seeds: seeds(`
      accountable acquire agenda allocate appraisal assign audit authorise benchmark bid billing
      bonus brief budget candidate capacity clause client collaborate commission commitment competent
      compliance confidential consensus constraint consultant contract coordinate credential criteria
      deadline delegate deliverable department deploy deputy diligence dismiss dispatch dividend
      draft efficiency eligible employ endorse enterprise entitlement escalate estimate evaluate
      executive expenditure expertise feasible feedback forecast freelance fulfil grievance headcount
      incentive induction initiative internship invoice itinerary leverage liability liaise logistics
      mandate margin memorandum mentor merger milestone morale negotiate objective onboarding
      operational outsource overhead oversee payroll pension personnel pitch portfolio precedent
      premises probation procurement productivity profitable promotion proposal prospect quota
      recruit redundancy referee referral reimburse remuneration resign resume retention revenue
      roster salary scope shareholder shortlist stakeholder strategy subordinate subsidiary supervise
      surplus tender tenure turnover vacancy venture verify vocational workflow workload
    `),
    // The JOB sheet is a short list, so the definition still does some work
    // once it and the curated core are in — held to the everyday tiers, or the
    // top-up drifts into words no workplace has ever used.
    want: (r) => r.x !== 'God Level'
      // "rogaine — a vasodilator (trade name Loniten)" is a drug, not a job.
      && !/\btrade names?\b/i.test(r.d)
      && /\b(business|company|employ|work|office|money|payment|contract|market|trade|manage|profit|commercial|industry)\b/i.test(`${r.d} ${r.s.join(' ')}`),
  },
  {
    group: 'Work & life', id: 'native', title: 'Native & Everyday', blurb: 'The plain, high-frequency words that make speech sound unforced.',
    level: 'A2–B1',
    seeds: seeds(`
      afford agree allow almost already although always amount answer appear arrive attend
      believe belong borrow bother bring build burn busy calm carry catch cause change cheap
      choose clean clear climb close cloudy collect comfortable common complain confuse continue
      cook copy correct crowd damage danger decide deep delay deliver depend describe die
      difficult dirty discover divide double doubt dream drop dry early earn easy empty enjoy
      enough enter escape exact expect explain fail famous fast fear feed feel fetch fight fill
      final find finish fit fix flat float fold follow forget forgive freeze fresh friendly
      frighten funny gather gentle gift glad grow guess handle happen hard hate heavy hide hold
      honest hope hurry hurt ignore imagine improve include increase invite join joke keep kind
      knock lack land late laugh lazy lead learn leave lend light listen lonely loose lose loud
      lucky manage mark matter measure meet mend mention mess mind miss mistake mix move narrow
      nearly need neat notice offer often open order pack pain pass patient pause perhaps pick
      plan pleasant polite pour practise prepare press pretend prevent promise proud pull push
      quiet quit raise reach ready realise receive refuse remain remember remind remove repair
      repeat replace reply rest return rich ring rise roll rough rude safe save scared search
      seem sell send serve settle shake shape share sharp shine shout show shut sigh silent
      simple sink skip sleep slide slip slow smart smell smile smooth solve sort sound spare
      speak spend spill spoil spread stare start stay steal stick stir stop straight strange
      stretch strike strong stupid succeed suggest suit support suppose surprise swallow sweep
      swim switch taste teach tear tell thick thin throw tidy tight tired touch train travel
      treat trust turn understand upset usual visit wait wake walk warm warn waste watch wave
      weak wear weigh welcome wet whisper whole wide wild win wipe wish wonder worry wrap
    `),
    // The everyday tier, narrowed to the words other entries keep pointing at
    // as synonyms.
    want: (r) => central(r.w) >= 3 && r.x === 'Easy',
  },
  {
    group: 'Work & life', id: 'elite', title: 'Elite', blurb: 'Rare and literary words — the ones that make a reader stop.',
    level: 'C2',
    seeds: seeds(`
      abstruse acerbic acumen adumbrate aplomb apocryphal apotheosis arcane assiduity atavistic
      bellicose bowdlerize bucolic byzantine cavil chthonic circumlocution coruscate crepuscular
      defenestrate deleterious desultory diaphanous dilettante disquisition dolorous ebullience
      effulgent eldritch encomium ennui epistolary equanimity eschew evanescent execrable exigent
      fastidiousness feckless felicitous fissiparous frisson fulsome gallimaufry gossamer halcyon
      hagiography hegemony hermetic hubris ignominy imbroglio immanent impecunious imprimatur
      inchoate incunabula ineluctable inimical insouciance intransigence inveigle jejune kismet
      lachrymose lacuna limpid litany logorrhea lucubration luminous magniloquent maunder mellifluous
      mendacity meretricious minatory misanthrope moribund nadir nascent necromancy nugatory obdurate
      obloquy oleaginous panegyric parsimony pellucid penumbra perspicacious pettifog phlegmatic
      pillory polemic prescient prevaricate probity propinquity puissant pusillanimous quiescent
      quotidian recondite refulgent risible salubrious sanguine saturnine scintilla sedulous
      sepulchral serendipity solipsism somnolent sonorous stentorian stygian supercilious surfeit
      sybarite temerity tenebrous threnody torpid transmogrify truculence turpitude umbrage unctuous
      vainglorious vatic verisimilitude vertiginous vicissitude vituperate voluble wanton winnow
      zeitgeist zephyr
    `),
    /* The rarest tier holds 55,000 words — most of the dictionary's tail — so
       being in it is no longer the whole test. These are the ones nothing else
       points at as a synonym, no exam list claims, and that are long enough to
       be a choice rather than an accident. */
    want: (r) => r.x === 'God Level' && central(r.w) === 0
      && r.w.length >= 7 && r.sec.length === 0 && r.s.length >= 2
      && !compound(r.w)
      && !/^coming next after\b/i.test(r.d),   // "seventeenth" is not a rare word
  },
  {
    group: 'Work & life', id: 'science', title: 'Science & Medicine', blurb: 'The vocabulary of labs, bodies and papers — useful well beyond exams.',
    level: 'B2–C1',
    seeds: seeds(`
      abdomen acute aerobic ailment ambient amplitude analgesic anatomy antibody antigen aorta
      artery atrophy bacteria benign biopsy calibrate capillary carcinogen cardiac catalyst cell
      chronic circulation clinical coagulate cognition combustion compound conduction congenital
      contagious cranial density diagnosis dilate dosage electrolyte embryo endemic enzyme
      epidemic equilibrium erosion evaporate excrete fatigue fermentation fracture friction fungus
      gene genome gestation glucose gravity habitat hemorrhage hormone hypothesis immune incubate
      inertia infection inflammation ingest inhale inoculate insulin isotope lesion ligament
      lymphatic malignant membrane metabolism microbe migraine molecule mutation nausea nerve
      neuron nutrient organism osmosis oxidize pathogen pathology pharmaceutical photosynthesis
      physiology plasma pneumonia potency precipitate prognosis pulmonary radiation reagent
      recessive reflex remission renal respiration saline sedative solvent specimen spectrum
      sterile stimulus surgical suture symptom synthesis therapeutic thermal thrombosis tissue
      toxin trauma tumour vaccine vascular velocity vertebra viscosity
    `),
    want: (r) => /\b(medical|medicine|disease|body|cell|chemical|physics|biolog|organ|blood|nerve|scien|clinical|surg)\w*/i.test(`${r.d} ${r.s.join(' ')}`),
  },
  {
    group: 'Work & life', id: 'phrasal', title: 'Compounds & Phrases', blurb: 'Hyphenated and multi-word entries — the ones dictionaries hide at the back.',
    level: 'B1–C1',
    seeds: [],
    // Hyphenated forms are excluded from the main pool by the headword rule,
    // so this pack draws its own, held to the same cleaning.
    pool: () => [...byWord.values()].filter((r) =>
      /^[a-z][a-z]+-[a-z][a-z-]+$/.test(r.w) && r.d.length > 15
      && !TAXONOMIC.test(r.d) && !NOT_A_SENSE.test(r.d)
      && !BLOCKED.test(`${r.w} ${r.d}`) && !EXPLICIT.test(r.d) && r.s.length > 0),
    want: () => true,
  },
];

// ── build ─────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_MODULES, { recursive: true });
fs.mkdirSync(OUT_DICT, { recursive: true });

const manifest = [];
const claimed = new Set();   // keep the packs from overlapping too much

/* The curated cores were reading straight from the raw map, so seed words
   skipped every cleaning rule — which is exactly how "(informal) small and of
   little importance" kept turning up in a pack. Seeds are looked up in the
   filtered pool now, and a seed that fails the rules is simply dropped. */
const cleanIndex = new Map(pool.map((r) => [r.w, r]));
let seedsDropped = 0;

for (const mod of MODULES) {
  const source = mod.pool ? mod.pool() : pool;
  const picked = [];
  const take = (r) => {
    if (!r || picked.some((p) => p.w === r.w || sameFamily(p.w, r.w))) return;
    picked.push(r);
  };

  const rank = mod.rank || score;
  const byRank = (a, b) => rank(b) - rank(a) || a.w.localeCompare(b.w);

  // 1. the subject sheet, where the workbook names the list outright
  const fromSheet = mod.core ? source.filter(mod.core).sort(byRank) : [];
  for (const r of fromSheet) {
    if (picked.length >= TARGET) break;
    take(r);
  }
  const sheetHits = picked.length;

  // 2. the curated core, in the order written. It runs to whatever length it
  //    was written at when it *is* the list, and only fills the gap when a
  //    sheet has already spoken.
  for (const w of mod.seeds) {
    if (sheetHits && picked.length >= TARGET) break;
    const entry = cleanIndex.get(w) || (mod.pool ? source.find((r) => r.w === w) : null);
    if (entry && (!mod.allow || mod.allow(entry))) take(entry);
    else if (byWord.has(w)) seedsDropped += 1;
  }
  const seedHits = picked.length - sheetHits;

  // 3. top up by score, preferring words no other module has taken
  const rest = source
    .filter((r) => mod.want(r) && !picked.includes(r))
    .sort(byRank);
  for (const r of rest) {
    if (picked.length >= TARGET) break;
    if (claimed.has(r.w)) continue;
    take(r);
  }
  for (const r of rest) {          // second pass allows overlap if still short
    if (picked.length >= TARGET) break;
    take(r);
  }
  for (const r of picked) claimed.add(r.w);

  // `sec` is how a pack was chosen, not something the app reads; it stays here.
  const words = picked.map(({ sec, ...r }) => r);

  const file = `${mod.id}.json`;
  fs.writeFileSync(path.join(OUT_MODULES, file),
    JSON.stringify({ id: mod.id, title: mod.title, blurb: mod.blurb, level: mod.level, words }));
  manifest.push({
    id: mod.id, title: mod.title, blurb: mod.blurb, level: mod.level,
    group: mod.group || 'Work & life', count: picked.length, file,
  });
  const from = [sheetHits && `${sheetHits} from sheet`, seedHits && `${seedHits} curated`]
    .filter(Boolean).join(', ') || 'all topped up';
  console.log(`${(mod.group || '').padEnd(12)} ${mod.title.padEnd(24)} ${String(picked.length).padStart(4)} words  (${from})`);
}

fs.writeFileSync(path.join(OUT_MODULES, 'index.json'), JSON.stringify(manifest, null, 2));
report.seedsDroppedByFilter = seedsDropped;
console.log(`\n${seedsDropped} curated seed words dropped by the cleaning rules`);

// ── the whole dataset, sharded for offline lookup ─────────────────────────
// Sharded on the first two letters, and any bucket that still comes out fat is
// split again on three — fetching 570 KB to look up one word on a phone is not
// a trade worth making. The index records which prefixes went three deep so the
// client knows which key to ask for.
const SHARD_LIMIT = 140 * 1024;
/* Shard keys become file names, so anything that is not a plain letter
   collapses to an underscore — the client sanitises identically. */
const prefixOf = (w, n) => w.slice(0, n).replace(/[^a-z]/g, '_').padEnd(n, '_');

function bucket(words, depth) {
  const out = new Map();
  for (const r of words) {
    const key = prefixOf(r.w, depth);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
}

const entries = [...byWord.values()];
const shards = new Map();
const deep = [];

for (const [key, group] of bucket(entries, 2)) {
  const size = JSON.stringify(group).length;
  if (size <= SHARD_LIMIT || group.length < 40) {
    shards.set(key, group);
    continue;
  }
  deep.push(key);
  for (const [key3, group3] of bucket(group, 3)) shards.set(key3, group3);
}

let total = 0;
for (const [key, group] of shards) {
  const words = {};
  for (const r of group) words[r.w] = { p: r.p, d: r.d, e: r.e, s: r.s, bn: r.bn, hi: r.hi, zh: r.zh };
  const json = JSON.stringify(words);
  fs.writeFileSync(path.join(OUT_DICT, `${key}.json`), json);
  total += json.length;
}

fs.writeFileSync(path.join(OUT_DICT, 'index.json'), JSON.stringify({
  words: byWord.size,
  shards: shards.size,
  /** prefixes that were split three letters deep */
  deep: deep.sort(),
}));

report.modules = manifest.map(({ id, count }) => ({ id, count }));
report.dictionary = byWord.size;
report.generatedAt = new Date().toISOString().slice(0, 10);
fs.writeFileSync('data/quality-report.json', JSON.stringify(report, null, 2));

console.log('\ncleaning');
for (const [rule, n] of Object.entries(report.repaired).sort((a, b) => b[1] - a[1])) {
  console.log(`  repaired  ${rule.padEnd(30)} ${String(n).padStart(6)}`);
}
for (const [rule, n] of Object.entries(report.harvested)) {
  console.log(`  harvested ${rule.padEnd(30)} ${String(n).padStart(6)}`);
}
for (const [rule, n] of Object.entries(report.rejected).sort((a, b) => b[1] - a[1])) {
  console.log(`  rejected  ${rule.padEnd(30)} ${String(n).padStart(6)}`);
}

const biggest = [...shards.entries()]
  .map(([k, v]) => [k, JSON.stringify(Object.fromEntries(v.map((r) => [r.w, r]))).length])
  .sort((a, b) => b[1] - a[1])[0];
console.log(`\ndictionary: ${byWord.size} words across ${shards.size} shards, ${(total / 1e6).toFixed(1)} MB`);
console.log(`largest shard: ${biggest[0]}.json at ${(biggest[1] / 1024).toFixed(0)} KB (${deep.length} prefixes split three deep)`);
