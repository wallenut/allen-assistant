// Tests for /api/capture, /api/promote/propose, /api/promote/apply
// Uses an in-process HTTP server with mocked adapter + in-memory store.
// No real API key or network required.
// Run: node wallenut/test.memory_endpoints.js

import http from 'node:http';
import assert from 'node:assert';
import { extractFacts, writeBufferFacts, readBufferFacts, proposePromotion, applyPromotion } from './memory.js';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeStore() {
  const db = new Map();
  return {
    db,
    async read(path) {
      return db.has(path) ? { content: db.get(path), sha: 'mock-sha' } : null;
    },
    async write(path, { content }) {
      db.set(path, content);
      return { sha: 'mock-sha' };
    },
    async remove(path) {
      db.delete(path);
    },
  };
}

const GOOD_FACTS = [
  { type: 'fact', content: 'Allen lifts on Tuesdays', source: 'user' },
  { type: 'preference', content: 'Allen prefers early mornings', source: 'user' },
];

const GOOD_FACTS_JSON = JSON.stringify(GOOD_FACTS);

function makeGoodLlm() {
  return async (_system, _text) => GOOD_FACTS_JSON;
}

const GOOD_PROPOSALS = [
  { file: 'fitness/current_state.md', op: 'append', rationale: 'lift schedule', addition: '- lifts Tuesdays' },
];
const GOOD_PROPOSALS_JSON = JSON.stringify(GOOD_PROPOSALS);

function makeProposalLlm() {
  return async () => GOOD_PROPOSALS_JSON;
}

// ── In-process endpoint handlers (mirror server.js logic, mocked seams) ──────

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

async function handleCapture(body, { store, llm, apiKey }) {
  if (!apiKey) return { status: 503, json: { error: 'runtime not configured' } };
  try {
    const { messages } = body;
    const facts = await extractFacts(messages, { llm });
    await writeBufferFacts(facts, { store });
    return { status: 200, json: { count: facts.length } };
  } catch (err) {
    return { status: 500, json: { error: err.message } };
  }
}

async function handlePropose(body, { store, llm, apiKey }) {
  if (!apiKey) return { status: 503, json: { error: 'runtime not configured' } };
  try {
    const date = body?.date || todayDate();
    const facts = await readBufferFacts(date, { store });
    const wikiFiles = ['fitness/current_state.md', 'allen_synthesis.md'];
    const proposals = await proposePromotion(facts, { llm, store, wikiFiles });
    return { status: 200, json: { proposals } };
  } catch (err) {
    return { status: 500, json: { error: err.message } };
  }
}

async function handleApply(body, { store, apiKey }) {
  if (!apiKey) return { status: 503, json: { error: 'runtime not configured' } };
  try {
    const { approved = [] } = body;
    const date = body?.date || todayDate();
    const summary = await applyPromotion(approved, { store });

    // Archive buffer
    const srcPath = `buffer/${date}.json`;
    const dstPath = `buffer/reviewed/${date}.json`;
    const src = await store.read(srcPath);
    if (src) {
      await store.write(dstPath, { content: src.content, message: `buffer: reviewed ${date}` });
      await store.remove(srcPath);
    }

    return { status: 200, json: { summary } };
  } catch (err) {
    return { status: 500, json: { error: err.message } };
  }
}

// ── Test harness ──────────────────────────────────────────────────────────────

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

// ── /api/capture tests ────────────────────────────────────────────────────────

await test('/api/capture: 503 when API key missing', async () => {
  const result = await handleCapture({ messages: [] }, { store: makeStore(), llm: makeGoodLlm(), apiKey: null });
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.json.error, 'runtime not configured');
});

await test('/api/capture: returns { count } with correct fact count', async () => {
  const store = makeStore();
  const messages = [
    { role: 'user', content: 'I lift on Tuesdays' },
    { role: 'assistant', content: 'Noted — Tuesday lifts.' },
  ];
  const result = await handleCapture({ messages }, { store, llm: makeGoodLlm(), apiKey: 'test-key' });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.json.count, 2, `expected 2 facts, got ${result.json.count}`);
});

await test('/api/capture: facts are written to store', async () => {
  const store = makeStore();
  const messages = [
    { role: 'user', content: 'I lift on Tuesdays' },
    { role: 'assistant', content: 'Got it.' },
  ];
  await handleCapture({ messages }, { store, llm: makeGoodLlm(), apiKey: 'test-key' });
  const date = todayDate();
  const saved = await readBufferFacts(date, { store });
  assert.ok(saved.length > 0, 'facts should be written to store');
  assert.ok(saved[0].ts, 'facts should have ts stamped');
});

await test('/api/capture: does NOT swallow LLM errors — returns 500', async () => {
  const store = makeStore();
  const badLlm = async () => 'not json at all { broken';
  const messages = [
    { role: 'user', content: 'something' },
    { role: 'assistant', content: 'yes' },
  ];
  const result = await handleCapture({ messages }, { store, llm: badLlm, apiKey: 'test-key' });
  assert.strictEqual(result.status, 500, 'should return 500 on LLM error');
  assert.ok(result.json.error, 'error message should be present');
  assert.ok(/json|JSON|malformed/i.test(result.json.error), `error should mention JSON: ${result.json.error}`);
});

await test('/api/capture: empty messages returns { count: 0 } without error', async () => {
  const store = makeStore();
  // extractFacts returns [] for < 2 messages — no LLM call, no error.
  const result = await handleCapture({ messages: [] }, { store, llm: makeGoodLlm(), apiKey: 'test-key' });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.json.count, 0);
});

// ── /api/promote/propose tests ────────────────────────────────────────────────

await test('/api/promote/propose: 503 when API key missing', async () => {
  const result = await handlePropose({}, { store: makeStore(), llm: makeProposalLlm(), apiKey: null });
  assert.strictEqual(result.status, 503);
});

await test('/api/promote/propose: returns { proposals } array', async () => {
  const store = makeStore();
  const date = '2026-06-14';
  // Pre-populate buffer and wiki file.
  await writeBufferFacts(GOOD_FACTS, { store, date });
  await store.write('fitness/current_state.md', { content: '# Fitness\n- existing\n' });

  const result = await handlePropose({ date }, { store, llm: makeProposalLlm(), apiKey: 'test-key' });
  assert.strictEqual(result.status, 200);
  assert.ok(Array.isArray(result.json.proposals), 'proposals should be an array');
  assert.strictEqual(result.json.proposals.length, 1);
  assert.ok(result.json.proposals[0].file, 'proposal should have file');
  assert.ok(result.json.proposals[0].op, 'proposal should have op');
});

await test('/api/promote/propose: empty buffer returns empty proposals', async () => {
  const store = makeStore();
  // No facts in buffer — proposePromotion returns [] for empty facts.
  const result = await handlePropose({ date: '2020-01-01' }, { store, llm: makeProposalLlm(), apiKey: 'test-key' });
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(result.json.proposals, []);
});

// ── /api/promote/apply tests ─────────────────────────────────────────────────

await test('/api/promote/apply: 503 when API key missing', async () => {
  const result = await handleApply({ approved: [] }, { store: makeStore(), apiKey: null });
  assert.strictEqual(result.status, 503);
});

await test('/api/promote/apply: applies approved proposals + returns summary', async () => {
  const store = makeStore();
  await store.write('fitness/current_state.md', { content: '# Fitness\n- existing\n' });

  const approved = [
    { file: 'fitness/current_state.md', op: 'append', addition: '- lifts Tuesdays', rationale: 'test' },
  ];
  const result = await handleApply({ approved, date: '2026-06-14' }, { store, apiKey: 'test-key' });
  assert.strictEqual(result.status, 200);
  assert.ok(typeof result.json.summary === 'string', 'summary should be a string');
  assert.ok(result.json.summary.includes('fitness/current_state.md'), `summary: ${result.json.summary}`);

  const after = await store.read('fitness/current_state.md');
  assert.ok(after.content.includes('- lifts Tuesdays'), 'addition written to wiki file');
});

await test('/api/promote/apply: archives buffer/{date}.json after apply', async () => {
  const store = makeStore();
  const date = '2026-06-14';
  await writeBufferFacts(GOOD_FACTS, { store, date });
  await store.write('fitness/current_state.md', { content: '# Fitness\n' });

  const approved = [
    { file: 'fitness/current_state.md', op: 'append', addition: '- new fact', rationale: 'r' },
  ];
  await handleApply({ approved, date }, { store, apiKey: 'test-key' });

  // Source should be gone; destination should exist.
  const src = await store.read(`buffer/${date}.json`);
  const dst = await store.read(`buffer/reviewed/${date}.json`);
  assert.strictEqual(src, null, 'original buffer should be removed');
  assert.ok(dst, 'reviewed copy should exist');
});

await test('/api/promote/apply: empty approved is a no-op (no wiki writes)', async () => {
  const store = makeStore();
  await store.write('fitness/current_state.md', { content: '# Fitness\noriginal\n' });
  const sizeBefore = store.db.size;

  const result = await handleApply({ approved: [], date: '2026-06-14' }, { store, apiKey: 'test-key' });
  assert.strictEqual(result.status, 200);
  // fitness file unchanged
  const after = await store.read('fitness/current_state.md');
  assert.ok(after.content.includes('original'), 'file should be unchanged');
});

await test('/api/promote/apply: returns 500 if apply throws (anchor not found)', async () => {
  const store = makeStore();
  await store.write('fitness/current_state.md', { content: '# Fitness\n' });

  const approved = [
    { file: 'fitness/current_state.md', op: 'replace', anchor: 'MISSING ANCHOR', addition: 'x', rationale: 'r' },
  ];
  const result = await handleApply({ approved, date: '2026-06-14' }, { store, apiKey: 'test-key' });
  assert.strictEqual(result.status, 500);
  assert.ok(result.json.error, 'error should be present');
});

// ─── summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
