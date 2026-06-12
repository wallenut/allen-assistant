import 'dotenv/config'
import readline from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from './adapters/claude.js';
import { buildRegistry, defaultTools } from './registry.js';
import { runLoop } from './loop.js';
import { assembleSystem, BASE_PROMPT } from './context.js';
import { captureBuffer } from './episodic.js';

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
  const messages = [];

  // One readline for the whole REPL: both the task prompt and the bash confirm-gate
  // read from it. A second interface on the same stdin races for input — a stray
  // keystroke gets read as a new task and launches a concurrent loop that corrupts
  // the shared message history. So the bash gate reuses this rl via rl.question.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirm = (cmd) =>
    new Promise((resolve) => {
      rl.question(`\n  run bash: ${cmd}\n  approve? [y/N] `, (answer) => resolve(/^y/i.test(answer.trim())));
    });
  const tools = defaultTools(confirm);
  const registry = buildRegistry(tools);

  console.log('Wallenut. Type a task; Ctrl-C to quit.\n');
  rl.setPrompt('> ');
  rl.prompt();

  // Guard: one turn at a time. Input arriving mid-turn (e.g. an extra confirm keystroke)
  // must not start a second concurrent runLoop against the shared `messages`.
  let running = false;
  rl.on('line', async (line) => {
    const task = line.trim();
    if (!task) return rl.prompt();
    if (running) {
      console.log('  (busy — finish the current task first)');
      return;
    }
    running = true;
    messages.push({ role: 'user', content: task });
    // Route this turn to the relevant wiki door(s); fall back to the bare prompt on failure.
    let system = BASE_PROMPT;
    try {
      system = await assembleSystem(task);
    } catch (err) {
      console.error(`  (wiki context unavailable: ${err.message})`);
    }
    try {
      const out = await runLoop({ adapter, registry, tools, messages, onEvent, system });
      console.log(`\n${out.text}\n`);
    } catch (err) {
      console.error(`\nLoop error: ${err.message}\n`);
    } finally {
      running = false;
      rl.prompt();
    }
  });

  rl.on('close', async () => {
    const wikiDir = process.env.WIKI_DIR || join(homedir(), 'allen-wiki');
    const result = await Promise.resolve(captureBuffer(messages, wikiDir));
    if (result.appended) {
      console.log('  (session saved to buffer)');
    } else {
      console.log(`  (buffer save skipped: ${result.reason})`);
    }
    process.exit(0);
  });
}

main();
