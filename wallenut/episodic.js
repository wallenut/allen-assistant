// P5a: lifecycle writeback. At session end, appends a plaintext summary of the
// conversation to {wikiDir}/buffer/{YYYY-MM-DD}.md and git-commits it. No LLM call.
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Render a single content value to a short string.
// Assistant content arrives as an array of blocks ({type:'text'|'tool_use'|...});
// extract text blocks and skip tool calls / tool results.
function renderContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(b => b && b.type === 'text')
      .map(b => b.text)
      .join(' ')
      .trim();
    return text || null;
  }
  return String(content);
}

// Format a messages array as a markdown session block.
function formatBlock(messages) {
  const lines = [`## ${new Date().toISOString()}`];
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = renderContent(msg.content);
    if (!text || !text.trim()) continue;
    const truncated = text.length > 600 ? text.slice(0, 600) + '…' : text;
    lines.push(`**${msg.role}:** ${truncated}`);
  }
  if (lines.length <= 1) return null; // only heading, no real turns
  return lines.join('\n') + '\n';
}

export function captureBuffer(messages, wikiDir) {
  const date = today();
  const bufferDir = join(wikiDir, 'buffer');
  const path = join(bufferDir, `${date}.md`);

  try {
    if (!existsSync(wikiDir)) return { path, appended: false, reason: 'wiki dir unavailable' };

    const block = formatBlock(messages);
    if (!block) return { path, appended: false, reason: 'no real turns to save' };

    if (!existsSync(bufferDir)) mkdirSync(bufferDir, { recursive: true });

    appendFileSync(path, block, 'utf8');

    execSync(
      `git -C ${JSON.stringify(wikiDir)} add buffer/${date}.md && git -C ${JSON.stringify(wikiDir)} commit -m "buffer: ${date} session"`,
      { stdio: 'pipe' }
    );

    return { path, appended: true };
  } catch (err) {
    return { path, appended: false, reason: err.message };
  }
}
