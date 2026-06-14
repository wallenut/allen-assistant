// Live smoke test for the memory core (Build A) — runs the REAL extractFacts on a
// real transcript and (optionally) writes the resulting buffer/{date}.json.
//
// The core is LLM-agnostic: extractFacts takes an injected `llm`. Locally there's no
// ANTHROPIC_API_KEY (only on Railway), so this smoke injects a Gemini-backed llm using
// VITE_GEMINI_API_KEY. Production will inject a Claude-backed llm instead — same core.
//
// Usage:
//   node wallenut/test.live.memory.js                       # dry run on the sample chat (extract + print only)
//   node wallenut/test.live.memory.js path/to/messages.json # dry run on your own transcript
//   node wallenut/test.live.memory.js --write               # also write buffer/{date}.json to the GitHub wiki
//   node wallenut/test.live.memory.js --write --local       # write to the local ~/allen-wiki clone instead
//
// A transcript file is a JSON array of { role: "user"|"assistant", content: string }.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { extractFacts, writeBufferFacts, readBufferFacts, proposePromotion } from './memory.js';
import { makeGitHubStore, makeLocalGitStore } from './store.js';

const args = process.argv.slice(2);
const doWrite = args.includes('--write');
const useLocal = args.includes('--local');
const doPromote = args.includes('--promote');
const fileArg = args.find((a) => !a.startsWith('--')) || 'wallenut/scratch/chat_2026-06-12.json';

// Gemini-backed llm shim matching memory.js's contract: async (system, userText) => string
const genAI = new GoogleGenerativeAI(process.env.VITE_GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
const llm = async (system, userText) => {
  const res = await model.generateContent(`${system}\n\n${userText}`);
  return res.response.text();
};

async function runPromote() {
  // Validate the librarian half: read today's buffer from the real wiki and propose edits.
  const store = makeGitHubStore({
    token: process.env.VITE_GITHUB_TOKEN,
    repo: (process.env.VITE_GITHUB_WIKI_REPO || 'wallenut/allen-wiki').split('/')[1],
    owner: (process.env.VITE_GITHUB_WIKI_REPO || 'wallenut/allen-wiki').split('/')[0],
  });
  const date = new Date().toISOString().slice(0, 10);
  const facts = await readBufferFacts(date, { store });
  console.log(`Read ${facts.length} facts from buffer/${date}.json\n`);

  // Wiki file list for door routing.
  const owner = (process.env.VITE_GITHUB_WIKI_REPO || 'wallenut/allen-wiki').split('/')[0];
  const repo = (process.env.VITE_GITHUB_WIKI_REPO || 'wallenut/allen-wiki').split('/')[1];
  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`, {
    headers: { Authorization: `token ${process.env.VITE_GITHUB_TOKEN}` },
  });
  const treeData = await treeRes.json();
  const wikiFiles = (treeData.tree || []).filter((n) => n.type === 'blob').map((n) => n.path);

  console.log('→ proposePromotion (Gemini librarian, propose-only)...\n');
  const proposals = await proposePromotion(facts, { llm, store, wikiFiles });
  console.log(`✓ ${proposals.length} proposals:\n`);
  for (const p of proposals) {
    console.log(`  [${p.op}] ${p.file}`);
    console.log(`     why: ${p.rationale}`);
    if (p.anchor) console.log(`     anchor: "${p.anchor.slice(0, 60)}..."`);
    console.log(`     add: ${String(p.addition).slice(0, 160).replace(/\n/g, ' ')}...\n`);
  }
  console.log('(propose-only — nothing written. Apply is human-gated.)');
}

async function main() {
  if (doPromote) return runPromote();
  const messages = JSON.parse(readFileSync(fileArg, 'utf8'));
  console.log(`Transcript: ${fileArg} (${messages.length} messages)\n`);

  console.log('→ extractFacts (Gemini)...');
  const facts = await extractFacts(messages, { llm });
  console.log(`✓ ${facts.length} facts extracted:\n`);
  for (const f of facts) {
    console.log(`  [${f.type}/${f.source}] ${f.content}`);
  }

  if (!doWrite) {
    console.log('\n(dry run — pass --write to persist to buffer/{date}.json)');
    return;
  }

  const store = useLocal
    ? makeLocalGitStore()
    : makeGitHubStore({ token: process.env.VITE_GITHUB_TOKEN });
  const target = useLocal ? '~/allen-wiki (local git)' : 'GitHub wiki (wallenut/allen-wiki)';

  console.log(`\n→ writeBufferFacts to ${target}...`);
  await writeBufferFacts(facts, { store });

  const date = new Date().toISOString().slice(0, 10);
  const written = await readBufferFacts(date, { store });
  console.log(`✓ buffer/${date}.json now holds ${written.length} total facts.`);
}

main().catch((err) => {
  console.error('✗ smoke failed:', err.message);
  process.exit(1);
});
