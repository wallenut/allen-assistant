// wallenut/memory.js — shared memory core. Peer to the agent loop, not on it.
// All functions are pure (LLM + store injected) — fully mockable, TDD-friendly.
// No session state is held here; the frozen-snapshot principle is honored by design.
//
// Exports:
//   extractFacts(messages, { llm })                           → facts[]
//   writeBufferFacts(facts, { store, date? })                → void
//   readBufferFacts(date, { store })                          → facts[]
//   proposePromotion(facts, { llm, store, wikiFiles })        → proposals[]
//   applyPromotion(approvedProposals, { store })              → string (summary)

import { discoverDoors, selectContext } from '../src/wikiContext.js';

// ── Extraction prompt (stenographer) ─────────────────────────────────────────
// Adapted from src/buffer.js EXTRACTION_PROMPT; returns bare JSON, no markdown.
const EXTRACTION_PROMPT =
  'You are a silent stenographer. Extract atomic facts, decisions, preferences, and open ' +
  'questions from the conversation transcript below. Return ONLY a JSON array of objects ' +
  'with shape {"type":"fact"|"decision"|"preference"|"question","content":string,"source":"user"|"assistant"}. ' +
  'Set "source" to "user" if explicitly stated or confirmed by the user, "assistant" if generated ' +
  'from the assistant\'s own knowledge. No markdown, no explanation, no code fences.';

// ── Promotion prompt (librarian) ─────────────────────────────────────────────
function promotionPrompt(facts, wikiContent) {
  return (
    'You are a careful wiki librarian. Given the facts below and the current wiki content, ' +
    'produce a JSON array of surgical edit proposals. Each proposal must have:\n' +
    '  { "file": string, "op": "append"|"replace"|"create", "anchor"?: string, ' +
    '"rationale": string, "addition": string }\n' +
    '"replace" uses "anchor" as a literal substring to locate and replace — be exact.\n' +
    '"append" adds "addition" to the end of the file.\n' +
    '"create" writes a new file with "addition" as full content.\n' +
    'Only propose changes that are clearly supported by the facts. ' +
    'Return ONLY the JSON array, no markdown, no explanation.\n\n' +
    '## Facts to integrate\n' +
    JSON.stringify(facts, null, 2) +
    '\n\n## Current wiki content\n' +
    wikiContent
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function stripFences(raw) {
  return raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '').trim();
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function bufferPath(date) {
  return `buffer/${date}.json`;
}

// Build a plain transcript string for the extraction LLM call.
function buildTranscript(messages) {
  return messages
    .map((m) => {
      let text;
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        // Extract text blocks; skip tool_use / tool_result blocks.
        text = m.content
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim();
      } else {
        text = String(m.content ?? '');
      }
      if (!text) return null;
      const speaker = m.role === 'user' ? 'User' : 'Assistant';
      return `${speaker}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Stenographer: one plain LLM call, no tools, no loop.
 * THROWS on malformed/non-array JSON — silent failure was the original bug.
 * Returns [] for fewer than 2 messages (nothing worth extracting).
 *
 * @param {Array} messages - conversation message array (role + content)
 * @param {{ llm: (system: string, userText: string) => Promise<string> }} opts
 * @returns {Promise<Array>} facts[]
 */
export async function extractFacts(messages, { llm }) {
  if (!messages || messages.length < 2) return [];

  const transcript = buildTranscript(messages);
  if (!transcript) return [];

  const raw = await llm(EXTRACTION_PROMPT, transcript);
  const cleaned = stripFences(raw);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`extractFacts: malformed JSON from LLM — ${err.message}\nRaw response: ${raw.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`extractFacts: expected array from LLM, got ${typeof parsed}`);
  }

  return parsed;
}

/**
 * Append facts (with ts) to buffer/{date}.json. Merges with existing array.
 * No-op if facts is empty.
 *
 * @param {Array} facts
 * @param {{ store: object, date?: string }} opts
 */
export async function writeBufferFacts(facts, { store, date = todayUTC() } = {}) {
  if (!facts || facts.length === 0) return;

  const path = bufferPath(date);
  const ts = new Date().toISOString();
  const stamped = facts.map((f) => ({ ...f, ts }));

  // Read existing, merge, write back.
  let existing = [];
  const current = await store.read(path);
  if (current) {
    try {
      existing = JSON.parse(current.content);
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }

  const merged = [...existing, ...stamped];
  await store.write(path, {
    content: JSON.stringify(merged, null, 2),
    message: `episodic: ${date}`,
    sha: current?.sha,
  });
}

/**
 * Read & parse buffer/{date}.json. Returns [] if absent or unreadable.
 *
 * @param {string} date - YYYY-MM-DD
 * @param {{ store: object }} opts
 * @returns {Promise<Array>}
 */
export async function readBufferFacts(date, { store }) {
  const path = bufferPath(date);
  const result = await store.read(path);
  if (!result) return [];
  try {
    const parsed = JSON.parse(result.content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Librarian: propose wiki edits for a set of facts. No writes happen here.
 * Reuses discoverDoors/selectContext from src/wikiContext.js for routing.
 *
 * @param {Array} facts
 * @param {{ llm, store, wikiFiles: string[] }} opts
 *   wikiFiles: repo-relative paths of all wiki files (used for door discovery)
 * @returns {Promise<Array>} proposals[]
 */
export async function proposePromotion(facts, { llm, store, wikiFiles = [] }) {
  if (!facts || facts.length === 0) return [];

  // Route facts to relevant doors using the existing router.
  const doors = discoverDoors(wikiFiles);
  // Use a combined query from fact contents to drive routing.
  const query = facts.map((f) => f.content).join(' ');
  const selected = selectContext(query, doors);

  // Read selected wiki files (best-effort; skip missing).
  const blocks = [];
  for (const relPath of selected) {
    const result = await store.read(relPath);
    if (result) {
      blocks.push(`## ${relPath}\n${result.content}`);
    }
  }
  const wikiContent = blocks.join('\n\n') || '(no wiki content available)';

  const prompt = promotionPrompt(facts, wikiContent);
  const raw = await llm(prompt, 'Produce the proposals.');
  const cleaned = stripFences(raw);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`proposePromotion: malformed JSON from LLM — ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`proposePromotion: expected array from LLM, got ${typeof parsed}`);
  }

  return parsed;
}

/**
 * Mechanically apply approved proposals to wiki files via store.
 * Ops: append | replace (anchor substring) | create.
 * Returns a plain-text summary of what was applied.
 *
 * @param {Array} approvedProposals
 * @param {{ store: object }} opts
 * @returns {Promise<string>} summary
 */
export async function applyPromotion(approvedProposals, { store }) {
  if (!approvedProposals || approvedProposals.length === 0) return 'No proposals to apply.';

  const lines = [];

  for (const proposal of approvedProposals) {
    const { file, op, anchor, addition, rationale } = proposal;

    if (op === 'create') {
      await store.write(file, {
        content: addition,
        message: `memory: create ${file}`,
      });
      lines.push(`created ${file}: ${rationale}`);
      continue;
    }

    // append or replace — need to read the existing file first.
    const existing = await store.read(file);
    const current = existing?.content ?? '';

    if (op === 'append') {
      const updated = current + addition;
      await store.write(file, {
        content: updated,
        message: `memory: append to ${file}`,
        sha: existing?.sha,
      });
      lines.push(`appended to ${file}: ${rationale}`);
      continue;
    }

    if (op === 'replace') {
      if (!anchor) throw new Error(`applyPromotion: replace op on ${file} missing anchor`);
      if (!current.includes(anchor)) {
        throw new Error(`applyPromotion: anchor not found in ${file} — "${anchor}"`);
      }
      const updated = current.replace(anchor, addition);
      await store.write(file, {
        content: updated,
        message: `memory: replace in ${file}`,
        sha: existing?.sha,
      });
      lines.push(`replaced in ${file}: ${rationale}`);
      continue;
    }

    lines.push(`skipped unknown op "${op}" for ${file}`);
  }

  return lines.join('\n');
}
