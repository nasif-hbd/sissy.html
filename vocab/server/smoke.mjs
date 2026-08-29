#!/usr/bin/env node
/**
 * End-to-end check against a running proxy.  Usage:
 *
 *   npm start                # in one terminal
 *   npm run smoke            # in another
 *
 * Exercises every route the browser uses and prints what came back, so you can
 * see the real wire shapes before wiring anything else to them.
 */
const BASE = process.env.VOCABX_PROXY || 'http://localhost:8787';

const post = async (route, body) => {
  const res = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const streamPost = async (route, body) => {
  const res = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return `HTTP ${res.status}`;
  let out = '';
  for await (const chunk of res.body) {
    for (const line of Buffer.from(chunk).toString().split('\n')) {
      if (!line.startsWith('data:')) continue;
      const evt = JSON.parse(line.slice(5));
      if (evt.type === 'text_delta') out += evt.text;
      if (evt.type === 'error') return `error: ${evt.error}`;
    }
  }
  return out;
};

const health = await (await fetch(`${BASE}/api/health`)).json();
console.log('health          ', health);

if (!health.hasKey) {
  console.log('\nNo ANTHROPIC_API_KEY on the proxy — stopping here.');
  process.exit(0);
}

const word = await post('/api/ai/word', { term: 'ubiquitous', level: 'B2' });
console.log('\nword            ', JSON.stringify(word.body.data, null, 2));

const quiz = await post('/api/ai/quiz', {
  term: 'ubiquitous',
  definition: 'present everywhere at once',
  distractors: ['abundant', 'scarce', 'obvious'],
  level: 'B2',
});
console.log('\nquiz            ', JSON.stringify(quiz.body.data, null, 2));

const suggest = await post('/api/ai/suggest', { level: 'B2', known: ['resilient', 'meticulous'], count: 3 });
console.log('\nsuggest         ', JSON.stringify(suggest.body.data, null, 2));

console.log('\ncoach (stream)  ', await streamPost('/api/ai/coach', {
  term: 'ubiquitous',
  definition: 'present everywhere at once',
  sentence: 'Smartphones are ubiquitous in the city, everyone has it.',
  level: 'B2',
}));

console.log('\nreport (stream) ', await streamPost('/api/ai/report', {
  stats: {
    level: 'B2', streak: 6, deckSize: 42, knownWords: 18,
    reviewsLast7Days: 180, accuracyLast7Days: 78, activeDaysLast7: 6,
    strugglingWords: [{ term: 'plausible', wrong: 4, seen: 6 }],
  },
}));

console.log('\nassess (stream) ', await streamPost('/api/ai/assess', {
  estimate: {
    level: 'B1', band: 'Moderate', bandIndex: 1, reached: true,
    answered: 16, correct: 8, accuracy: 0.5, confidence: 'good',
    perBand: [
      { band: 'Easy', cefr: 'A2', label: 'Everyday', seen: 2, right: 2, accuracy: 1, judged: true },
      { band: 'Moderate', cefr: 'B1', label: 'Common', seen: 6, right: 6, accuracy: 1, judged: true },
      { band: 'Advanced', cefr: 'B2', label: 'Academic', seen: 6, right: 0, accuracy: 0, judged: true },
      { band: 'God Level', cefr: 'C2', label: 'Rare', seen: 2, right: 0, accuracy: 0, judged: true },
    ],
    knownWords: { known: 2228, total: 3200 },
  },
  plan: {
    level: 'B1', newPerDay: 8, dailyGoal: 20,
    paceWhy: 'A steady start for B1.',
    modules: [{ title: 'SAT', why: '56% of it sits just above your level.' }],
    revisit: ['plausible', 'coherent'],
    notes: [],
  },
  deck: { size: 42, streak: 6 },
}));
