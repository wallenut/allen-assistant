import readline from 'node:readline';
import { ClaudeAdapter } from './adapters/claude.js';
import { buildRegistry, defaultTools } from './registry.js';
import { runLoop } from './loop.js';

// Print tool calls and results as the loop runs.
function onEvent(evt) {
  if (evt.type === 'tool_call') {
    console.log(`  → ${evt.name}(${JSON.stringify(evt.args)})`);
  } else if (evt.type === 'tool_result') {
    const preview = evt.result.length > 500 ? evt.result.slice(0, 500) + '…' : evt.result;
    console.log(`  ← ${preview.replace(/\n/g, '\n    ')}`);
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Export it before running the REPL.');
    process.exit(1);
  }

  const adapter = new ClaudeAdapter();
  // Tools share the REPL's stdin for the bash confirm-gate (default confirm prompts there).
  const tools = defaultTools();
  const registry = buildRegistry(tools);
  const messages = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Jarvis. Type a task; Ctrl-C to quit.\n');
  rl.setPrompt('> ');
  rl.prompt();

  rl.on('line', async (line) => {
    const task = line.trim();
    if (!task) return rl.prompt();
    messages.push({ role: 'user', content: task });
    try {
      const out = await runLoop({ adapter, registry, tools, messages, onEvent });
      console.log(`\n${out.text}\n`);
    } catch (err) {
      console.error(`\nLoop error: ${err.message}\n`);
    }
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

main();
