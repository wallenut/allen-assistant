// TDD tests for wallenut/memory.js — no network, no API key, no LLM.
// Mock llm and store are injected. Run: node wallenut/test.memory.js
import assert from 'node:assert';
import {
  extractFacts,
  writeBufferFacts,
  readBufferFacts,
  proposePromotion,
  applyPromotion,
} from './memory.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeStore() {
  const db = new Map();
  return {
    db,
    async read(path) {
      return db.has(path) ? { content: db.get(path) } : null;
    },
    async write(path, { content }) {
      db.set(path, content);
      return { sha: 'fake-sha' };
    },
    async remove(path) {
      db.delete(path);
    },
  };
}

const GOOD_FACTS_JSON = JSON.stringify([
  { type: 'fact', content: 'Allen does pec work', source: 'user' },
  { type: 'preference', content: 'Allen prefers mornings', source: 'user' },
]);

const GOOD_LLM = async (_system, _text) => GOOD_FACTS_JSON;
const BAD_LLM = async () => 'not json at all { broken';
const EMPTY_ARRAY_LLM = async () => '[]';

const SAMPLE_MESSAGES = [
  { role: 'user', content: 'Hey, I do pec work every morning.' },
  { role: 'assistant', content: 'Got it — morning pec work.' },
];

const ONE_MESSAGE = [{ role: 'user', content: 'hi' }];

// ─── test suite ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ── extractFacts ──────────────────────────────────────────────────────────

await test('extractFacts: parses good JSON and returns facts array', async () => {
  const facts = await extractFacts(SAMPLE_MESSAGES, { llm: GOOD_LLM });
  assert.ok(Array.isArray(facts), 'should return array');
  assert.strictEqual(facts.length, 2, 'should have 2 facts');
  assert.strictEqual(facts[0].type, 'fact');
  assert.strictEqual(facts[1].type, 'preference');
});

await test('extractFacts: THROWS on malformed JSON (not returns [])', async () => {
  await assert.rejects(
    () => extractFacts(SAMPLE_MESSAGES, { llm: BAD_LLM }),
    /malformed|JSON|parse/i,
    'should throw with a clear error message about JSON'
  );
});

await test('extractFacts: returns [] for fewer than 2 messages', async () => {
  const facts = await extractFacts(ONE_MESSAGE, { llm: GOOD_LLM });
  assert.deepStrictEqual(facts, []);
});

await test('extractFacts: returns [] for empty messages array', async () => {
  const facts = await extractFacts([], { llm: GOOD_LLM });
  assert.deepStrictEqual(facts, []);
});

await test('extractFacts: returns [] for null/undefined messages', async () => {
  const facts = await extractFacts(null, { llm: GOOD_LLM });
  assert.deepStrictEqual(facts, []);
});

await test('extractFacts: THROWS when LLM returns empty array string and messages >= 2', async () => {
  // [] is valid JSON and an array — but there are 0 facts. This is fine (not an error).
  const facts = await extractFacts(SAMPLE_MESSAGES, { llm: EMPTY_ARRAY_LLM });
  assert.deepStrictEqual(facts, []);
});

await test('extractFacts: THROWS when LLM returns non-array JSON object', async () => {
  const objectLLM = async () => JSON.stringify({ type: 'fact', content: 'x' });
  await assert.rejects(
    () => extractFacts(SAMPLE_MESSAGES, { llm: objectLLM }),
    /not an array|expected array/i,
    'should throw when result is a JSON object not an array'
  );
});

await test('extractFacts: strips markdown code fences from LLM response', async () => {
  const fencedLLM = async () => '```json\n' + GOOD_FACTS_JSON + '\n```';
  const facts = await extractFacts(SAMPLE_MESSAGES, { llm: fencedLLM });
  assert.strictEqual(facts.length, 2);
});

// ── writeBufferFacts / readBufferFacts ────────────────────────────────────

await test('writeBufferFacts: no-op when facts is empty', async () => {
  const store = makeStore();
  await writeBufferFacts([], { store, date: '2026-06-14' });
  assert.strictEqual(store.db.size, 0, 'nothing written');
});

await test('writeBufferFacts + readBufferFacts: round-trip', async () => {
  const store = makeStore();
  const facts = [
    { type: 'fact', content: 'Allen runs 5k', source: 'user' },
    { type: 'decision', content: 'Skip gym Friday', source: 'assistant' },
  ];
  await writeBufferFacts(facts, { store, date: '2026-06-14' });
  const read = await readBufferFacts('2026-06-14', { store });
  assert.strictEqual(read.length, 2);
  assert.strictEqual(read[0].type, 'fact');
  assert.strictEqual(read[0].content, 'Allen runs 5k');
  assert.ok(read[0].ts, 'facts should have ts stamped');
});

await test('readBufferFacts: returns [] when file absent', async () => {
  const store = makeStore();
  const facts = await readBufferFacts('2020-01-01', { store });
  assert.deepStrictEqual(facts, []);
});

await test('writeBufferFacts: merges with existing buffer (append not overwrite)', async () => {
  const store = makeStore();
  const batch1 = [{ type: 'fact', content: 'first fact', source: 'user' }];
  const batch2 = [{ type: 'preference', content: 'second fact', source: 'user' }];
  await writeBufferFacts(batch1, { store, date: '2026-06-14' });
  await writeBufferFacts(batch2, { store, date: '2026-06-14' });
  const all = await readBufferFacts('2026-06-14', { store });
  assert.strictEqual(all.length, 2, 'both batches merged');
  assert.strictEqual(all[0].content, 'first fact');
  assert.strictEqual(all[1].content, 'second fact');
});

await test('writeBufferFacts: uses today date when date omitted', async () => {
  const store = makeStore();
  const facts = [{ type: 'fact', content: 'x', source: 'user' }];
  await writeBufferFacts(facts, { store }); // no date arg
  const today = new Date().toISOString().slice(0, 10);
  const result = await readBufferFacts(today, { store });
  assert.strictEqual(result.length, 1);
});

// ── proposePromotion ──────────────────────────────────────────────────────

const PROPOSAL_LLM_RESPONSE = JSON.stringify([
  {
    file: 'fitness/current_state.md',
    op: 'append',
    rationale: 'new pec routine fact',
    addition: '- Allen does pec work every morning.',
  },
  {
    file: 'fitness/current_state.md',
    op: 'replace',
    anchor: 'old pec note',
    rationale: 'updated pec note',
    addition: 'new pec note',
  },
]);

await test('proposePromotion: returns op-tagged proposals array', async () => {
  const store = makeStore();
  // Pre-populate a wiki file so the librarian has content to read.
  await store.write('fitness/current_state.md', { content: 'old pec note\n' });

  const proposalLLM = async () => PROPOSAL_LLM_RESPONSE;
  const facts = [{ type: 'fact', content: 'Allen does pec work every morning', source: 'user' }];
  const wikiFiles = ['fitness/current_state.md', 'allen_synthesis.md'];

  const proposals = await proposePromotion(facts, { llm: proposalLLM, store, wikiFiles });
  assert.ok(Array.isArray(proposals), 'should return array');
  assert.strictEqual(proposals.length, 2);
  assert.ok(proposals.every(p => p.op && p.file && p.rationale && p.addition), 'proposals have required fields');
  assert.ok(proposals.some(p => p.op === 'append'), 'has append proposal');
  assert.ok(proposals.some(p => p.op === 'replace'), 'has replace proposal');
});

await test('proposePromotion: does NOT write to store (propose only)', async () => {
  const store = makeStore();
  await store.write('fitness/current_state.md', { content: 'original content\n' });
  const sizeBefore = store.db.size;

  const proposalLLM = async () => PROPOSAL_LLM_RESPONSE;
  const facts = [{ type: 'fact', content: 'test', source: 'user' }];
  await proposePromotion(facts, { llm: proposalLLM, store, wikiFiles: ['fitness/current_state.md'] });

  // Verify the file content is unchanged (no write happened via propose)
  const after = await store.read('fitness/current_state.md');
  assert.strictEqual(after.content, 'original content\n', 'propose must not mutate the store');
});

// ── applyPromotion ────────────────────────────────────────────────────────

await test('applyPromotion: append op appends text to file', async () => {
  const store = makeStore();
  await store.write('fitness/current_state.md', { content: '# Fitness\n\n- existing item\n' });

  const proposals = [
    { file: 'fitness/current_state.md', op: 'append', addition: '- new item\n', rationale: 'test' },
  ];
  const summary = await applyPromotion(proposals, { store });

  const after = await store.read('fitness/current_state.md');
  assert.ok(after.content.includes('- existing item'), 'existing content preserved');
  assert.ok(after.content.includes('- new item'), 'new content appended');
  assert.ok(typeof summary === 'string', 'returns summary string');
});

await test('applyPromotion: replace op does substring replacement via anchor', async () => {
  const store = makeStore();
  await store.write('life/current_state.md', {
    content: '# Life\n\nCurrent city: Beijing\n\nOther stuff\n',
  });

  const proposals = [
    {
      file: 'life/current_state.md',
      op: 'replace',
      anchor: 'Current city: Beijing',
      addition: 'Current city: Shanghai',
      rationale: 'moved cities',
    },
  ];
  await applyPromotion(proposals, { store });

  const after = await store.read('life/current_state.md');
  assert.ok(after.content.includes('Current city: Shanghai'), 'anchor replaced');
  assert.ok(!after.content.includes('Current city: Beijing'), 'old anchor gone');
  assert.ok(after.content.includes('Other stuff'), 'rest of file preserved');
});

await test('applyPromotion: create op writes new file', async () => {
  const store = makeStore();

  const proposals = [
    {
      file: 'new/topic.md',
      op: 'create',
      addition: '# New Topic\n\n- first fact\n',
      rationale: 'new domain',
    },
  ];
  await applyPromotion(proposals, { store });

  const file = await store.read('new/topic.md');
  assert.ok(file, 'file was created');
  assert.ok(file.content.includes('first fact'), 'content written');
});

await test('applyPromotion: replace with missing anchor falls back to append (does not throw, does not lose the update)', async () => {
  const store = makeStore();
  await store.write('life/current_state.md', { content: '# Life\n\nSome content\n' });

  const proposals = [
    {
      file: 'life/current_state.md',
      op: 'replace',
      anchor: 'ANCHOR THAT DOES NOT EXIST',
      addition: 'replacement text',
      rationale: 'test',
    },
  ];
  const summary = await applyPromotion(proposals, { store });
  const after = await store.read('life/current_state.md');
  assert.ok(after.content.includes('replacement text'), 'update should still land via append fallback');
  assert.ok(after.content.includes('Some content'), 'original content preserved');
  assert.match(summary, /anchor not found|review/i, 'summary should flag the fallback for manual review');
});

await test('applyPromotion: replace tolerates whitespace drift in the anchor', async () => {
  const store = makeStore();
  await store.write('fitness/current_state.md', { content: '# Fitness\n\n- Aerobic   this week:   sprints owed\n' });

  const proposals = [
    {
      file: 'fitness/current_state.md',
      op: 'replace',
      anchor: '- Aerobic this week: sprints owed', // single-spaced; file has runs of spaces
      addition: '- Aerobic this week: interval run completed',
      rationale: 'test whitespace-flexible match',
    },
  ];
  await applyPromotion(proposals, { store });
  const after = await store.read('fitness/current_state.md');
  assert.ok(after.content.includes('interval run completed'), 'flexible match should replace despite whitespace drift');
  assert.ok(!after.content.includes('sprints owed'), 'old text replaced, not appended');
});

await test('applyPromotion: one failing proposal does not abort the batch', async () => {
  const store = makeStore();
  await store.write('life/current_state.md', { content: '# Life\n\ncontent\n' });

  const proposals = [
    { file: 'life/current_state.md', op: 'append', addition: '- good append', rationale: 'valid' },
    { file: 'life/current_state.md', op: 'replace', anchor: undefined, addition: 'x', rationale: 'bad — no anchor' },
    { file: 'life/current_state.md', op: 'append', addition: '- second good append', rationale: 'valid' },
  ];
  const summary = await applyPromotion(proposals, { store });
  const after = await store.read('life/current_state.md');
  assert.ok(after.content.includes('- good append'), 'first valid proposal applied');
  assert.ok(after.content.includes('- second good append'), 'proposal after the failing one still applied');
  assert.match(summary, /FAILED/, 'summary records the failed proposal');
});

await test('applyPromotion: append op ensures clean line separator (no jammed lines)', async () => {
  const store = makeStore();
  // File ending WITHOUT trailing newline — simulates the jam case.
  await store.write('fitness/current_state.md', { content: '# Fitness\n- existing item' });

  const proposals = [
    { file: 'fitness/current_state.md', op: 'append', addition: '- new item', rationale: 'test separator' },
  ];
  await applyPromotion(proposals, { store });

  const after = await store.read('fitness/current_state.md');
  // Must have exactly two newlines between existing content and addition.
  assert.ok(
    after.content.includes('- existing item\n\n- new item'),
    `expected double-newline separator, got: ${JSON.stringify(after.content)}`
  );
  // addition.trim() + trailing newline.
  assert.ok(after.content.endsWith('- new item\n'), `should end with trailing newline: ${JSON.stringify(after.content)}`);
});

await test('applyPromotion: append op trims trailing whitespace from existing content before adding separator', async () => {
  const store = makeStore();
  // File ending with extra whitespace/newlines.
  await store.write('fitness/current_state.md', { content: '# Fitness\n- existing item\n\n\n  ' });

  const proposals = [
    { file: 'fitness/current_state.md', op: 'append', addition: '- appended', rationale: 'test trim' },
  ];
  await applyPromotion(proposals, { store });

  const after = await store.read('fitness/current_state.md');
  // Should not have more than two newlines between sections.
  assert.ok(
    !after.content.match(/\n{3,}/),
    `should not have triple+ newlines: ${JSON.stringify(after.content)}`
  );
  assert.ok(after.content.includes('- existing item\n\n- appended\n'), `correct separator: ${JSON.stringify(after.content)}`);
});

await test('applyPromotion: applies multiple proposals in order', async () => {
  const store = makeStore();
  await store.write('fitness/current_state.md', { content: '# Fitness\nold note\n' });

  const proposals = [
    { file: 'fitness/current_state.md', op: 'append', addition: '- fact 1\n', rationale: 'r1' },
    { file: 'fitness/current_state.md', op: 'append', addition: '- fact 2\n', rationale: 'r2' },
  ];
  await applyPromotion(proposals, { store });

  const after = await store.read('fitness/current_state.md');
  assert.ok(after.content.includes('- fact 1'), 'fact 1 appended');
  assert.ok(after.content.includes('- fact 2'), 'fact 2 appended');
  // Verify ordering: fact 1 before fact 2
  assert.ok(after.content.indexOf('fact 1') < after.content.indexOf('fact 2'), 'order preserved');
});

// ─── summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
