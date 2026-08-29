import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sameFamily } from '../scripts/family.mjs';

/*
 * The shipped word packs, checked as data.
 *
 * Everything here is a rule that was broken at some point by a build that ran
 * clean: "terrorist" in Grade 9–10, "smoke — street names for marijuana" in
 * Grade 1–5, University repeating Grade 11–12 word for word. The builder has
 * rules against each of those now, and this is the independent check that they
 * held — so the patterns below are deliberately written out again rather than
 * imported, or a mistake in one regex would pass both sides.
 */
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/modules/${f}`, import.meta.url), 'utf8'));
const index = read('index.json');
const packs = index.map((m) => ({ ...m, words: read(m.file).words }));

const BANDS = ['Easy', 'Moderate', 'Advanced', 'God Level'];
const SCHOOL = /^(grade-|university)/;
const ADULT = /^(sex|sexy|sexual|sexuality|erotic|porn|pornography|bondage|fetish|rape|incest|prostitute|prostitution|brothel|terror|terrorist|terrorism|suicide|murder|massacre|genocide|torture|narcotic|heroin|cocaine|opium|marijuana|cannabis|molest|obscene)$/i;
const ADULT_SENSE = /\b(sexual\w*|erotic\w*|porn\w*|bondage|fetish|incest|prostitut\w*|brothel|marijuana|cannabis|cocaine|heroin|narcotics?|opium)\b/i;
const NOT_A_SENSE = /^street names? for\b|\bterrorist organization\b/i;

test('the manifest and the packs agree', () => {
  assert.ok(packs.length >= 14, 'every module is listed');
  for (const p of packs) {
    assert.equal(p.count, p.words.length, `${p.id}: manifest count matches the file`);
    assert.ok(p.words.length >= 300, `${p.id}: ${p.words.length} words is too thin a pack`);
    assert.ok(['School', 'Exams', 'Work & life'].includes(p.group), `${p.id}: known group`);
  }
});

test('every word is teachable', () => {
  for (const p of packs) {
    for (const w of p.words) {
      assert.match(w.w, /^[a-z][a-z'-]{1,17}$/, `${p.id}: "${w.w}" is not a headword`);
      assert.ok(w.d && w.d.length >= 12, `${p.id}/${w.w}: definition "${w.d}" is too short`);
      assert.ok(w.p, `${p.id}/${w.w}: no part of speech`);
      assert.ok(BANDS.includes(w.x), `${p.id}/${w.w}: band "${w.x}" is not one the app knows`);
      assert.doesNotMatch(w.d, NOT_A_SENSE, `${p.id}/${w.w}: not a sense of the word`);
    }
  }
});

test('a pack never teaches the same word, or the same family, twice', () => {
  for (const p of packs) {
    const seen = [];
    for (const w of p.words) {
      const clash = seen.find((s) => s === w.w || sameFamily(s, w.w));
      assert.equal(clash, undefined, `${p.id}: "${w.w}" repeats "${clash}"`);
      seen.push(w.w);
    }
  }
});

test('school packs stay on school topics', () => {
  for (const p of packs.filter((m) => SCHOOL.test(m.id))) {
    for (const w of p.words) {
      assert.doesNotMatch(w.w, ADULT, `${p.id}: "${w.w}" does not belong in a school pack`);
      assert.doesNotMatch(w.d, ADULT_SENSE, `${p.id}/${w.w}: "${w.d}" is not a school sense`);
    }
  }
});

test('no two packs are the same pack', () => {
  for (let i = 0; i < packs.length; i++) {
    for (let j = i + 1; j < packs.length; j++) {
      const a = new Set(packs[i].words.map((w) => w.w));
      const shared = packs[j].words.filter((w) => a.has(w.w)).length;
      const limit = Math.min(a.size, packs[j].words.length) * 0.4;
      assert.ok(shared <= limit,
        `${packs[i].id} and ${packs[j].id} share ${shared} words — one of them is redundant`);
    }
  }
});

test('the school ladder climbs', () => {
  // A grade pack should sit no lower than the one below it. Comparing the
  // average band index catches a ladder that has come loose from the data.
  const level = (p) => p.words.reduce((n, w) => n + BANDS.indexOf(w.x), 0) / p.words.length;
  const ladder = ['grade-1-5', 'grade-6-8', 'grade-9-10', 'grade-11-12', 'university']
    .map((id) => packs.find((p) => p.id === id));
  assert.ok(ladder.every(Boolean), 'every rung exists');
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(level(ladder[i]) > level(ladder[i - 1]),
      `${ladder[i].id} (${level(ladder[i]).toFixed(2)}) should be harder than ${ladder[i - 1].id} (${level(ladder[i - 1]).toFixed(2)})`);
  }
});

test('every band the placement test asks about has words to ask with', () => {
  const mix = {};
  for (const p of packs) for (const w of p.words) mix[w.x] = (mix[w.x] || 0) + 1;
  for (const band of BANDS) {
    assert.ok((mix[band] || 0) >= 200, `only ${mix[band] || 0} words in the ${band} band`);
  }
});
