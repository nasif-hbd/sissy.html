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

const clean = (s) => (s || '').trim();
const records = body
  .filter((r) => r.length > 3 && clean(r[col.word]))
  .map((r) => ({
    w: clean(r[col.word]).toLowerCase(),
    p: clean(r[col.part_of_speech]),
    d: clean(r[col.english_meaning]).replace(/\s+/g, ' ').slice(0, 190),
    s: [1, 2, 3].map((n) => clean(r[col[`synonym_${n}`]])).filter(Boolean),
    bn: clean(r[col.bangla_meaning]),
    hi: clean(r[col.hindi_meaning]),
    zh: clean(r[col.chinese_simplified]),
    x: clean(r[col.difficulty]),
  }));

console.log(`read ${records.length} rows`);

// One entry per headword: keep the richest (most synonyms + translations).
const byWord = new Map();
const richness = (r) => r.s.length + (r.bn ? 2 : 0) + (r.hi ? 1 : 0) + (r.zh ? 1 : 0) + (r.d ? 1 : 0);
for (const r of records) {
  const seen = byWord.get(r.w);
  if (!seen || richness(r) > richness(seen)) byWord.set(r.w, r);
}
console.log(`${byWord.size} unique headwords`);

// ── what makes an entry worth learning ────────────────────────────────────
const TAXONOMIC = /\b(genus|family|subfamily|order|phylum|any of (?:various|numerous)|widely distributed|native to|deciduous|evergreen|perennial herb|small tree|shrubs?|mollusk|arthropod)\b/i;
const PROPER = /^[A-Z]/;

function usable(r) {
  if (!/^[a-z][a-z-]{2,15}$/.test(r.w)) return false;   // single lower-case token
  if (!r.d || r.d.length < 12) return false;
  if (TAXONOMIC.test(r.d)) return false;
  if (PROPER.test(r.w)) return false;
  return true;
}

/** Higher is more worth a learner's time. */
function score(r) {
  let n = 0;
  n += Math.min(r.s.length, 3) * 2;          // synonyms mean a real sense
  n += r.bn ? 3 : 0;                          // curated rows carry translations
  n += r.hi ? 2 : 0;
  n += r.zh ? 1 : 0;
  n += r.w.length >= 5 && r.w.length <= 12 ? 2 : 0;
  n += /^(noun|verb|adjective|adverb)$/.test(r.p) ? 1 : 0;
  if (r.d.length > 40 && r.d.length < 130) n += 1;
  return n;
}

const pool = [...byWord.values()].filter(usable);
console.log(`${pool.length} usable entries`);

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
    want: (r) => r.x === 'Easy' && (r.bn || r.hi),
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
    want: (r) => r.x === 'God Level',
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
    // this pack deliberately takes what `usable()` rejects: the joined forms
    pool: () => [...byWord.values()].filter((r) =>
      /^[a-z][a-z]+-[a-z][a-z-]+$/.test(r.w) && r.d.length > 15 && !TAXONOMIC.test(r.d)),
    want: () => true,
  },
];

// ── build ─────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_MODULES, { recursive: true });
fs.mkdirSync(OUT_DICT, { recursive: true });

const manifest = [];
const claimed = new Set();   // keep the packs from overlapping too much

for (const mod of MODULES) {
  const source = mod.pool ? mod.pool() : pool;
  const picked = [];
  const take = (r) => {
    if (!r || picked.some((p) => p.w === r.w)) return;
    picked.push(r);
  };

  // 1. the curated core, in the order written
  for (const w of mod.seeds) take(byWord.get(w));
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
  for (const r of group) words[r.w] = { p: r.p, d: r.d, s: r.s, bn: r.bn, hi: r.hi, zh: r.zh };
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

const biggest = [...shards.entries()]
  .map(([k, v]) => [k, JSON.stringify(Object.fromEntries(v.map((r) => [r.w, r]))).length])
  .sort((a, b) => b[1] - a[1])[0];
console.log(`\ndictionary: ${byWord.size} words across ${shards.size} shards, ${(total / 1e6).toFixed(1)} MB`);
console.log(`largest shard: ${biggest[0]}.json at ${(biggest[1] / 1024).toFixed(0)} KB (${deep.length} prefixes split three deep)`);
