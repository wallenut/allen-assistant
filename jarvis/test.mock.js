// Deterministic test of the Jarvis spine — no API key required.
// A MockAdapter returns scripted tool calls; we drive the REAL loop + REAL tools.
// Proves: loop + tool interface + dispatch + result-feedback + termination.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import assert from 'node:assert';
import { runLoop } from './loop.js';
import { buildRegistry, defaultTools } from './registry.js';

const SCRATCH = new URL('./scratch/hello.js', import.meta.url).pathname;
const PROGRAM = 'for (let i = 1; i <= 5; i++) process.stdout.write(i + " ");\n';

// MockAdapter scripts three turns and mirrors the Claude adapter's return shape exactly.
class MockAdapter {
  constructor() {
    this.turn = 0;
  }
  async complete(_system, _messages, _tools) {
    this.turn++;
    if (this.turn === 1) {
      return this._toolTurn('w1', 'write', { path: SCRATCH, content: PROGRAM });
    }
    if (this.turn === 2) {
      return this._toolTurn('b1', 'bash', { cmd: `node ${SCRATCH}` });
    }
    // Final turn: no tool calls => DONE. Echo the bash result we were fed back.
    const lastResults = _messages[_messages.length - 1].content;
    const bashOut = lastResults.find((r) => r.tool_use_id === 'b1').content;
    return {
      assistantContent: [{ type: 'text', text: `Program output: ${bashOut.trim()}` }],
      text: `Program output: ${bashOut.trim()}`,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }
  _toolTurn(id, name, args) {
    const block = { type: 'tool_use', id, name, input: args };
    return { assistantContent: [block], text: '', toolCalls: [{ id, name, args }], stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
  }
}

async function run() {
  if (existsSync(SCRATCH)) rmSync(SCRATCH);
  process.env.JARVIS_AUTO_CONFIRM = '1'; // auto-confirm the bash gate

  const tools = defaultTools();
  const registry = buildRegistry(tools);
  const messages = [{ role: 'user', content: 'create scratch/hello.js that prints 1..5, run it, show output' }];
  const events = [];

  const out = await runLoop({
    adapter: new MockAdapter(),
    registry,
    tools,
    messages,
    onEvent: (e) => events.push(e),
  });

  // 1. File exists on disk with correct content.
  assert.ok(existsSync(SCRATCH), 'scratch/hello.js should exist on disk');
  assert.strictEqual(readFileSync(SCRATCH, 'utf8'), PROGRAM, 'file content matches');

  // 2. The bash result contained the program output.
  const bashResult = events.find((e) => e.type === 'tool_result' && e.name === 'bash');
  assert.ok(bashResult, 'bash tool ran');
  assert.ok(bashResult.result.includes('1 2 3 4 5'), `bash output should contain "1 2 3 4 5", got: ${bashResult.result}`);

  // 3. The loop terminated cleanly.
  assert.strictEqual(out.stopReason, 'end_turn', 'loop terminated on end_turn');
  assert.ok(out.text.includes('1 2 3 4 5'), 'final text reports the output');
  assert.strictEqual(out.steps, 3, 'loop ran exactly 3 steps');

  // Dispatch + result-feedback sanity: two tool calls were dispatched in order.
  const calls = events.filter((e) => e.type === 'tool_call').map((e) => e.name);
  assert.deepStrictEqual(calls, ['write', 'bash'], 'dispatched write then bash');

  rmSync(SCRATCH);
  console.log('PASS — mock-adapter spine test');
  console.log(`  steps=${out.steps} tokens=${out.totalTokens} final="${out.text}"`);
}

run().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
