// Phase 2: the context loader. Turns Wallenut into *Allen's* agent by routing each
// user turn to the relevant wiki front door(s) and prepending them to the system prompt.
// Reuses the pure router in src/wikiContext.js — discovery + selection live there.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverDoors, selectContext } from '../src/wikiContext.js';

// The Wallenut identity prompt. Single source of truth; loop.js keeps a back-compat const.
export const BASE_PROMPT =
  "You are Wallenut, Allen's local agent. You have tools to read/write/edit files and run bash in " +
  'the current working directory; use them for actual file and system tasks, then report.\n\n' +
  "When a section titled \"Allen's wiki context\" is present below, it is Allen's personal " +
  'knowledge base, already loaded inline and authoritative — answer questions about Allen, his ' +
  'projects, fitness, research, and life directly from it. The "## path" labels in that section ' +
  'are provenance from a separate wiki repository, NOT files in your working directory — do not ' +
  'try to read or open those paths with tools; the content is already in front of you.';

// List all .md files under dir as repo-relative POSIX paths. Skips .git. Returns []
// (not a throw) if the dir is missing/unreadable — the caller falls back to base prompt.
async function listMarkdown(dir) {
  const entries = await readdir(dir, { recursive: true });
  return entries
    .map((e) => e.split('\\').join('/')) // normalize Windows separators to POSIX
    .filter((p) => p.endsWith('.md') && !p.startsWith('.git/') && !p.includes('/.git/'));
}

// Build the routed system prompt for one user turn. Always returns a string;
// on any wiki failure returns basePrompt unchanged (CLAUDE.md: fall back, never block).
export async function assembleSystem(query, { wikiDir = process.env.WIKI_DIR || join(homedir(), 'allen-wiki'), basePrompt = BASE_PROMPT } = {}) {
  let paths;
  try {
    paths = await listMarkdown(wikiDir);
  } catch {
    return basePrompt; // wiki missing/unreadable — continue with the bare identity prompt
  }

  const doors = discoverDoors(paths);
  const selected = selectContext(query, doors);

  // Read each selected door from disk; skip ones not on disk (SYNTHESIS is always
  // in the door set even when the file is absent).
  const blocks = [];
  for (const rel of selected) {
    try {
      const text = await readFile(join(wikiDir, rel), 'utf8');
      blocks.push(`## ${rel}\n${text}`);
    } catch {
      // missing on disk — skip silently
    }
  }

  if (blocks.length === 0) return basePrompt; // nothing loaded — fall back

  return basePrompt + "\n\n# Allen's wiki context (routed for this turn)\n\n" + blocks.join('\n\n');
}
