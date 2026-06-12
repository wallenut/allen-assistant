// Deterministic test of the Phase 2 context loader — NO network, NO API key.
// Proves: (a) the router + fs read route a fitness query to the fitness door +
// synthesis and exclude unrelated domains, against the REAL ~/allen-wiki;
// (b) graceful fallback when the wiki dir is missing.
import assert from 'node:assert';
import { assembleSystem, BASE_PROMPT } from './context.js';

async function run() {
  // (a) A fitness query routes to the fitness door + synthesis, not research.
  const sys = await assembleSystem('how is my pec healing');

  assert.ok(sys.startsWith(BASE_PROMPT), 'system starts with the base identity prompt');
  assert.ok(sys.includes("# Allen's wiki context (routed for this turn)"), 'context block header present');

  // Fitness door content present (substrings taken from the real fitness/current_state.md).
  assert.ok(sys.includes('## fitness/current_state.md'), 'fitness door header present');
  assert.ok(sys.includes('Bridge / Maintenance block'), 'fitness-specific content present');
  assert.ok(sys.includes('Keith directive'), 'second fitness-specific substring present');

  // Synthesis always loaded.
  assert.ok(sys.includes('## allen_synthesis.md'), 'synthesis door header present');
  assert.ok(sys.includes('Living Synthesis Document'), 'synthesis content present');

  // Research-only content absent — unrelated domain doors must NOT be loaded.
  assert.ok(!sys.includes('## research/current_state.md'), 'research door header absent');
  assert.ok(!sys.includes('TokenTransformer'), 'research-only content absent (TokenTransformer)');
  assert.ok(!sys.includes('MaxSimTag'), 'research-only content absent (MaxSimTag)');

  // wiki directory path injected in happy path.
  assert.ok(sys.includes('Wiki directory:'), 'wiki directory path injected into system prompt');

  // (b) Missing wiki dir => base prompt + wiki path injected, no throw.
  const fallback = await assembleSystem('anything', { wikiDir: '/nonexistent' });
  assert.ok(fallback.startsWith(BASE_PROMPT), 'missing wiki dir: starts with base prompt');
  assert.ok(fallback.includes('/nonexistent'), 'missing wiki dir: wiki path injected');
  assert.ok(!fallback.includes("# Allen's wiki context (routed for this turn)"), 'missing wiki dir: no context block');

  console.log('PASS — context loader (routing + fs read + fallback)');
  console.log(`  routed system length=${sys.length} chars; fallback length=${fallback.length} chars`);
}

run().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
