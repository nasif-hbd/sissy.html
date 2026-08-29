import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/*
 * The shipped grammar bank, checked as data.
 *
 * The first bank was 54 items with seventeen topics carrying a single
 * question, so a Grammar round in the Test tab repeated itself inside two
 * sittings. These are the properties that keep that from coming back, plus the
 * ones a question needs to be answerable at all.
 */
const bank = JSON.parse(fs.readFileSync(new URL('../data/grammar/bank.json', import.meta.url), 'utf8'));
const LEVELS = ['A2', 'B1', 'B2', 'C1'];

test('the bank is deep enough to practise', () => {
  assert.ok(bank.items.length >= 180, `only ${bank.items.length} items`);
  const perTopic = {};
  for (const i of bank.items) perTopic[i.t] = (perTopic[i.t] || 0) + 1;
  assert.ok(Object.keys(perTopic).length >= 30, 'too few topics');
  for (const [topic, n] of Object.entries(perTopic)) {
    assert.ok(n >= 4, `"${topic}" has ${n} question(s) — a round would repeat itself`);
  }
});

test('every question can be answered', () => {
  for (const i of bank.items) {
    assert.ok(i.q.includes('____'), `nothing to fill in: ${i.q}`);
    assert.equal(i.o.length, 4, `not four options: ${i.q}`);
    assert.equal(new Set(i.o).size, 4, `a repeated option: ${i.q}`);
    assert.ok(Number.isInteger(i.a) && i.a >= 0 && i.a < 4, `answer out of range: ${i.q}`);
    assert.ok(i.o[i.a], `the answer is an empty option: ${i.q}`);
    assert.ok(LEVELS.includes(i.lv), `unknown level "${i.lv}": ${i.q}`);
    assert.ok(i.t, `no topic: ${i.q}`);
  }
});

test('a wrong answer is always explained', () => {
  for (const i of bank.items) {
    assert.ok(i.w && i.w.length > 25, `weak or missing explanation: ${i.q}`);
    // An explanation that only restates the answer teaches nothing.
    assert.notEqual(i.w.trim().toLowerCase(), i.o[i.a].trim().toLowerCase(), `explanation is just the answer: ${i.q}`);
  }
});

test('no question is asked twice', () => {
  const seen = new Set();
  for (const i of bank.items) {
    assert.ok(!seen.has(i.q), `duplicate prompt: ${i.q}`);
    seen.add(i.q);
  }
});

test('every level has enough to build a round from', () => {
  const perLevel = {};
  for (const i of bank.items) perLevel[i.lv] = (perLevel[i.lv] || 0) + 1;
  for (const lv of LEVELS) {
    assert.ok((perLevel[lv] || 0) >= 15, `only ${perLevel[lv] || 0} items at ${lv}`);
  }
});

test('the manifest matches the items', () => {
  assert.equal(bank.count, bank.items.length);
  assert.deepEqual([...bank.topics].sort(), [...new Set(bank.items.map((i) => i.t))].sort());
  assert.deepEqual([...bank.levels].sort(), [...new Set(bank.items.map((i) => i.lv))].sort());
});
