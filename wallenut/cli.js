import 'dotenv/config'
import readline from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from './adapters/claude.js';
import { buildRegistry, defaultTools } from './registry.js';
import { runLoop } from './loop.js';
import { assembleSystem, BASE_PROMPT } from './context.js';
import { extractFacts, writeBufferFacts, readBufferFacts, proposePromotion, applyPromotion } from './memory.js';
import { makeLocalGitStore } from './store.js';

// Print tool calls and results as the loop runs.
function onEvent(evt) {
  if (evt.type === 'tool_call') {
    console.log(`  → ${evt.name}(${JSON.stringify(evt.args)})`);
  } else if (evt.type === 'tool_result') {
    const preview = evt.result.length > 500 ? evt.result.slice(0, 500) + '…' : evt.result;
    console.log(`  ← ${preview.replace(/\n/g, '\n    ')}`);
  }
}

// Build a shared llm shim from ClaudeAdapter for memory operations.
function makeLlm(adapter) {
  return async (system, user) =>
    (await adapter.complete(system, [{ role: 'user', content: user }], [])).text;
}

// ── Promote command ──────────────────────────────────────────────────────────
// Interactive terminal flow: propose → per-proposal y/n → apply.

async function runPromote(adapter, rl, store, date, wikiDir) {
  const llm = makeLlm(adapter);

  console.log(`\n  Reading buffer for ${date}…`);
  const facts = await readBufferFacts(date, { store });
  if (facts.length === 0) {
    console.log('  No facts in buffer for today. Run a session first.');
    return;
  }
  console.log(`  Found ${facts.length} facts. Proposing wiki edits…`);

  // Enumerate local wiki files for the router.
  let wikiFiles = [];
  try {
    const { readdirSync } = await import('node:fs');
    const { join: pjoin } = await import('node:path');
    function collectFiles(dir, base = '') {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) collectFiles(pjoin(dir, entry.name), rel);
        else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) wikiFiles.push(rel);
      }
    }
    collectFiles(wikiDir);
  } catch { /* wiki dir missing — empty list, proposePromotion handles gracefully */ }

  const proposals = await proposePromotion(facts, { llm, store, wikiFiles, today: date });
  if (proposals.length === 0) {
    console.log('  No proposals generated.');
    return;
  }

  console.log(`\n  ${proposals.length} proposal(s):\n`);
  const approved = [];

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    console.log(`  [${i + 1}/${proposals.length}] ${p.op.toUpperCase()} ${p.file}`);
    console.log(`  Rationale: ${p.rationale}`);
    console.log(`  Addition:\n    ${p.addition.replace(/\n/g, '\n    ')}`);

    const answer = await new Promise((resolve) =>
      rl.question('  Apply? [y/N] ', (a) => resolve(a.trim()))
    );
    if (/^y/i.test(answer)) {
      approved.push(p);
      console.log('  ✓ queued');
    } else {
      console.log('  — skipped');
    }
    console.log();
  }

  if (approved.length === 0) {
    console.log('  Nothing approved — wiki unchanged.');
    return;
  }

  console.log(`  Applying ${approved.length} proposal(s)…`);
  const summary = await applyPromotion(approved, { store });
  console.log(`  Done:\n  ${summary.replace(/\n/g, '\n  ')}`);

  // Archiving is explicit — un-promoted facts stay live unless you choose to file them.
  const archiveAns = await new Promise((resolve) =>
    rl.question('  Archive today\'s buffer (shelves un-promoted facts too)? [y/N] ', (a) => resolve(a.trim()))
  );
  if (/^y/i.test(archiveAns)) {
    const srcPath = `buffer/${date}.json`;
    const dstPath = `buffer/reviewed/${date}.json`;
    const src = await store.read(srcPath);
    if (src) {
      await store.write(dstPath, { content: src.content, message: `buffer: reviewed ${date}` });
      await store.remove(srcPath, { message: `buffer: archive ${date}` });
      console.log(`  Buffer archived to ${dstPath}.`);
    }
  } else {
    console.log('  Buffer kept active — un-promoted facts remain for next review.');
  }
}

// ── Main REPL ────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Export it before running the REPL.');
    process.exit(1);
  }

  const adapter = new ClaudeAdapter();
  const messages = [];

  const wikiDir = process.env.WIKI_DIR || join(homedir(), 'allen-wiki');
  const store = makeLocalGitStore({ wikiDir });

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

  console.log('Wallenut. Type a task; "promote" to review today\'s buffer; Ctrl-C to quit.\n');
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

    // Special promote command — runs the interactive promote flow.
    if (task === 'promote') {
      running = true;
      const date = new Date().toISOString().slice(0, 10);
      try {
        await runPromote(adapter, rl, store, date, wikiDir);
      } catch (err) {
        console.error(`  promote error: ${err.message}`);
      } finally {
        running = false;
        rl.prompt();
      }
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
    // Session-end capture: extract facts + write to buffer/{today}.json via local git store.
    if (messages.length >= 2) {
      try {
        const llm = makeLlm(adapter);
        const facts = await extractFacts(messages, { llm });
        await writeBufferFacts(facts, { store });
        if (facts.length > 0) {
          console.log(`  (${facts.length} facts saved to buffer)`);
        } else {
          console.log('  (session ended — no facts to save)');
        }
      } catch (err) {
        console.error(`  (buffer capture failed: ${err.message})`);
      }
    } else {
      console.log('  (session too short to capture)');
    }
    process.exit(0);
  });
}

main();
