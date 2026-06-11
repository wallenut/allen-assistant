// Live done-test through the real Claude adapter.
// Runs ONLY if ANTHROPIC_API_KEY is set; otherwise skips cleanly (does not fake it).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import assert from 'node:assert';
import { ClaudeAdapter } from './adapters/claude.js';
import { buildRegistry, defaultTools } from './registry.js';
import { runLoop } from './loop.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('SKIP — live Claude test (ANTHROPIC_API_KEY not set). Pending the key.');
  process.exit(0);
}

const SCRATCH = new URL('./scratch/hello.js', import.meta.url).pathname;

async function run() {
  if (existsSync(SCRATCH)) rmSync(SCRATCH);
  process.env.JARVIS_AUTO_CONFIRM = '1';

  const tools = defaultTools();
  const registry = buildRegistry(tools);
  const messages = [
    {
      role: 'user',
      content: `create a file ${SCRATCH} that prints the numbers 1 to 5, run it, and show me the output`,
    },
  ];

  const out = await runLoop({
    adapter: new ClaudeAdapter(),
    registry,
    tools,
    messages,
    onEvent: (e) =>
      e.type === 'tool_call' ? console.log(`  → ${e.name}(${JSON.stringify(e.args).slice(0, 120)})`) : null,
  });

  assert.ok(existsSync(SCRATCH), 'Jarvis wrote the file');
  assert.ok(/1\s*2\s*3\s*4\s*5/.test(out.text), `final report should contain 1 2 3 4 5, got: ${out.text}`);
  rmSync(SCRATCH);
  console.log('PASS — live Claude test');
  console.log(`  ${out.text}`);
}

run().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
