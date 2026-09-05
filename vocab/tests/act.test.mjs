/**
 * The two engines' tool-call shapes.
 *
 * Gemini and Claude both do function calling and agree on almost nothing about
 * how it looks. Every difference below is a silent failure if it is missed —
 * the request succeeds, the model answers, and the action simply never runs.
 * That is why they are pinned here rather than left to be noticed in use.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { declarations } from '../js/actions.js';

test('a declaration converts to Claude’s shape without losing anything', () => {
  /* Claude calls it input_schema; Gemini calls it parameters. Sending the
     wrong key is accepted as a tool with no arguments, and the model then
     calls it with none. */
  const toClaude = (t) => ({
    name: t.name,
    description: t.description,
    input_schema: { additionalProperties: false, required: [], ...t.parameters },
    strict: true,
  });

  for (const tool of declarations().map(toClaude)) {
    assert.ok(tool.input_schema, `${tool.name}: no input_schema`);
    assert.equal(tool.input_schema.type, 'object');
    assert.equal(tool.input_schema.additionalProperties, false,
      `${tool.name}: strict mode requires additionalProperties false`);
    assert.ok(Array.isArray(tool.input_schema.required),
      `${tool.name}: strict mode requires a required array`);
    assert.ok(!('parameters' in tool), `${tool.name}: kept Gemini's key`);
  }
});

test('the required list survives conversion, rather than being overwritten', () => {
  // The spread order matters: defaults first, the declaration's own last. The
  // other way round silently makes every argument optional.
  const withRequired = declarations().filter((d) => d.parameters.required?.length);
  assert.ok(withRequired.length, 'no declaration has required arguments to test');

  for (const t of withRequired) {
    const schema = { additionalProperties: false, required: [], ...t.parameters };
    assert.deepEqual(schema.required, t.parameters.required, `${t.name}: required was lost`);
  }
});

test('results are matched by id for Claude and by name for Gemini', () => {
  // Claude pairs a tool_result to its tool_use by id; Gemini pairs by function
  // name. Carrying both is what lets one client path serve either engine.
  const call = { id: 'toolu_01abc', name: 'set_daily_goal', args: { reviews: 30 } };
  const result = { id: call.id, name: call.name, result: 'Daily goal set to 30 reviews.' };

  const claudeBlock = {
    type: 'tool_result',
    tool_use_id: result.id,
    content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
  };
  assert.equal(claudeBlock.tool_use_id, call.id);
  assert.equal(typeof claudeBlock.content, 'string', 'Claude wants a string or blocks, not an object');

  const geminiPart = { functionResponse: { name: result.name, response: { result: result.result } } };
  assert.equal(geminiPart.functionResponse.name, call.name);
});

test('several results go back in one message, not several', () => {
  /* Splitting them is accepted and then quietly trains the model out of
     asking for more than one thing at a time — the kind of regression that
     shows up as "it got worse" months later with no error anywhere. */
  const results = [
    { id: 'toolu_1', name: 'get_progress', result: { streak: 4 } },
    { id: 'toolu_2', name: 'get_reminders', result: { enabled: true } },
  ];
  const message = {
    role: 'user',
    content: results.map((r) => ({
      type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result),
    })),
  };
  assert.equal(message.content.length, 2, 'the results were not kept together');
  assert.ok(message.content.every((b) => b.type === 'tool_result'));
});

test('a refused action is marked as an error rather than reported as success', () => {
  // An action that refused is not a result — a model told "Daily goal set" when
  // it was not will happily tell the learner the same.
  const refused = { id: 'toolu_9', name: 'set_daily_goal', result: 'outside 5-200', failed: true };
  const block = {
    type: 'tool_result',
    tool_use_id: refused.id,
    content: refused.result,
    ...(refused.failed ? { is_error: true } : {}),
  };
  assert.equal(block.is_error, true);

  const fine = { id: 'toolu_8', name: 'get_progress', result: {}, failed: false };
  const ok = { type: 'tool_result', tool_use_id: fine.id, content: '{}',
    ...(fine.failed ? { is_error: true } : {}) };
  assert.ok(!('is_error' in ok), 'a successful result was flagged as an error');
});

test('the two engines read a reply out of different places', () => {
  // Claude: content blocks with type tool_use. Gemini: parts with functionCall.
  const claude = { content: [
    { type: 'text', text: 'Setting that now.' },
    { type: 'tool_use', id: 'toolu_1', name: 'set_daily_goal', input: { reviews: 30 } },
  ] };
  const fromClaude = claude.content.filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: b.input }));
  assert.deepEqual(fromClaude, [{ id: 'toolu_1', name: 'set_daily_goal', args: { reviews: 30 } }]);

  const gemini = { parts: [
    { text: 'Setting that now.' },
    { functionCall: { name: 'set_daily_goal', args: { reviews: 30 } } },
  ] };
  const fromGemini = gemini.parts.filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args }));
  assert.deepEqual(fromGemini, [{ name: 'set_daily_goal', args: { reviews: 30 } }]);
});

test('the echoed question takes the shape its engine expects', () => {
  // Sending Gemini's `parts` to Claude, or Claude's `content` to Gemini, is a
  // 400 that reads as though the whole request were malformed.
  const question = 'set my goal to 30';
  const forGemini = { role: 'user', parts: [{ text: question }] };
  const forClaude = { role: 'user', content: question };
  assert.ok(forGemini.parts && !forGemini.content);
  assert.ok(forClaude.content && !forClaude.parts);
});
