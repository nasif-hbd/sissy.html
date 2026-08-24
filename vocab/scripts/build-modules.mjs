#!/usr/bin/env node
/**
 * Turns the source vocabulary CSV into what the app actually ships:
 *
 *   data/modules/index.json   the module manifest the Modules tab lists
 *   data/modules/<id>.json    one pack per module, fetched when opened
 *   data/dict/<a-z>.json      the whole dataset, sharded by first letter,
 *                             so adding a word is an offline lookup rather
 *                             than an API call
 *
 *   node scripts/build-modules.mjs path/to/word_meanings_dataset.csv
 *
 * Modules are built from a curated seed list per subject — the words that
 * genuinely belong on an IELTS or SAT list — topped up from the dataset by
 * score. Nothing here is hand-maintained afterwards: re-run it and the packs
 * are rebuilt.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
if (!SRC) { console.error('usage: build-modules.mjs <dataset.csv>'); process.exit(1); }

const OUT_MODULES = 'data/modules';
const OUT_DICT = 'data/dict';
const TARGET = Number(process.env.MODULE_SIZE || 400);

// ── a small CSV reader: quoted fields, embedded commas and newlines ────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const raw = fs.readFileSync(SRC, 'utf8').replace(/^﻿/, '');
const [header, ...body] = parseCsv(raw);
const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

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

const records = body
  .filter((r) => r.length > 3 && squash(r[col.word]))
  .map((r) => {
    report.rows += 1;
    const word = squash(r[col.word]).toLowerCase();
    const cleaned = cleanDefinition(r[col.english_meaning], word);
    return {
      w: word,
      p: squash(r[col.part_of_speech]).toLowerCase(),
      d: cleaned?.definition || '',
      e: cleaned?.examples || [],
      s: cleanSynonyms([1, 2, 3, 4, 5].map((n) => r[col[`synonym_${n}`]] || ''), word),
      bn: cleanTranslation(r[col.bangla_meaning], 'bn'),
      hi: cleanTranslation(r[col.hindi_meaning], 'hi'),
      zh: cleanTranslation(r[col.chinese_simplified], 'zh'),
      x: squash(r[col.difficulty]),
    };
  });

console.log(`read ${records.length} rows`);

// One entry per headword: keep the richest (most synonyms + translations).
const byWord = new Map();
const richness = (r) => r.s.length + (r.bn ? 2 : 0) + (r.hi ? 1 : 0) + (r.zh ? 1 : 0) + (r.d ? 1 : 0) + r.e.length;
for (const r of records) {
  const seen = byWord.get(r.w);
  if (!seen || richness(r) > richness(seen)) byWord.set(r.w, r);
}
console.log(`${byWord.size} unique headwords`);

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
  return n;
}

// ── the modules ───────────────────────────────────────────────────────────
// `seeds` are the words that genuinely define the subject; `want` decides
// which of the remaining dataset entries may top the pack up to TARGET.
const seeds = (s) => s.trim().split(/\s+/);

const MODULES = [
  {
    id: 'ielts', title: 'IELTS', blurb: 'Academic vocabulary that carries marks in Writing Task 2 and Reading.',
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
    want: (r) => ['Advanced', 'Moderate'].includes(r.x) && /^(noun|verb|adjective)$/.test(r.p),
  },
  {
    id: 'sat', title: 'SAT', blurb: 'The judgement-and-degree words American college tests keep coming back to.',
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
    want: (r) => ['Advanced', 'God Level'].includes(r.x) && /^(adjective|verb|noun)$/.test(r.p),
  },
  {
    id: 'admission-bd', title: 'Admission (BD)', blurb: 'Synonym-and-antonym drilling for Bangladeshi university admission tests.',
    level: 'B2–C1',
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
    id: 'job', title: 'Job & Workplace', blurb: 'Interviews, email, contracts and the language of getting things done.',
    level: 'B1–C1',
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
    want: (r) => /\b(business|company|employ|work|office|money|payment|contract|market|trade|manage|profit|commercial|industry|職)\b/i.test(`${r.d} ${r.s.join(' ')}`),
  },
  {
    id: 'native', title: 'Native & Everyday', blurb: 'The plain, high-frequency words that make speech sound unforced.',
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
    // Central words: the ones other entries keep pointing at as synonyms.
    want: (r) => central(r.w) >= 3 && ['Easy', 'Moderate'].includes(r.x),
  },
  {
    id: 'elite', title: 'Elite', blurb: 'Rare and literary words — the ones that make a reader stop.',
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
    // Peripheral by construction: nobody reaches for these as a synonym.
    want: (r) => r.x === 'God Level' && central(r.w) <= 1,
  },
  {
    id: 'science', title: 'Science & Medicine', blurb: 'The vocabulary of labs, bodies and papers — useful well beyond exams.',
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
    id: 'phrasal', title: 'Compounds & Phrases', blurb: 'Hyphenated and multi-word entries — the ones dictionaries hide at the back.',
    level: 'B1–C1',
    seeds: [],
    // Hyphenated forms are excluded from the main pool by the headword rule,
    // so this pack draws its own, held to the same cleaning.
    pool: () => [...byWord.values()].filter((r) =>
      /^[a-z][a-z]+-[a-z][a-z-]+$/.test(r.w) && r.d.length > 15
      && !TAXONOMIC.test(r.d) && !BLOCKED.test(`${r.w} ${r.d}`) && r.s.length > 0),
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
    if (!r || picked.some((p) => p.w === r.w)) return;
    picked.push(r);
  };

  // 1. the curated core, in the order written
  for (const w of mod.seeds) {
    const entry = cleanIndex.get(w) || (mod.pool ? source.find((r) => r.w === w) : null);
    if (entry) take(entry);
    else if (byWord.has(w)) seedsDropped += 1;
  }
  const seedHits = picked.length;

  // 2. top up by score, preferring words no other module has taken
  const rest = source
    .filter((r) => mod.want(r) && !picked.includes(r))
    .sort((a, b) => score(b) - score(a) || a.w.localeCompare(b.w));
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

  const file = `${mod.id}.json`;
  fs.writeFileSync(path.join(OUT_MODULES, file),
    JSON.stringify({ id: mod.id, title: mod.title, blurb: mod.blurb, level: mod.level, words: picked }));
  manifest.push({ id: mod.id, title: mod.title, blurb: mod.blurb, level: mod.level, count: picked.length, file });
  console.log(`${mod.title.padEnd(22)} ${String(picked.length).padStart(4)} words  (${seedHits} from the curated core)`);
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
