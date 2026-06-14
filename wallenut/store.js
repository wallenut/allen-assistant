// wallenut/store.js — thin storage seam.
// A store has three async methods:
//   read(path)                        → { content: string, sha?: string } | null
//   write(path, { content, message, sha })  → { sha }
//   remove(path, { message, sha })    → void
//
// Two implementations:
//   makeLocalGitStore({ wikiDir })  — node fs + git commit (CLI path)
//   makeGitHubStore({ owner, repo, token })  — GitHub Contents API (server path)
//
// Both fit the identical interface so memory.js is storage-agnostic.

import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ── Local Git Store ──────────────────────────────────────────────────────────

export function makeLocalGitStore({
  wikiDir = process.env.WIKI_DIR || join(homedir(), 'allen-wiki'),
} = {}) {
  function absPath(relPath) {
    return join(wikiDir, relPath);
  }

  return {
    async read(path) {
      const full = absPath(path);
      if (!existsSync(full)) return null;
      const content = await readFile(full, 'utf8');
      return { content };
    },

    async write(path, { content, message = `memory: update ${path}` }) {
      const full = absPath(path);
      const dir = dirname(full);
      await mkdir(dir, { recursive: true });
      await writeFile(full, content, 'utf8');
      // git add + commit
      const q = JSON.stringify(wikiDir);
      execSync(
        `git -C ${q} add ${JSON.stringify(path)} && git -C ${q} commit -m ${JSON.stringify(message)}`,
        { stdio: 'pipe' }
      );
      return { sha: undefined }; // local git doesn't expose a blob sha easily
    },

    async remove(path, { message = `memory: remove ${path}` } = {}) {
      const full = absPath(path);
      if (existsSync(full)) {
        await rm(full);
      }
      const q = JSON.stringify(wikiDir);
      execSync(
        `git -C ${q} rm --cached -f ${JSON.stringify(path)} && git -C ${q} commit -m ${JSON.stringify(message)}`,
        { stdio: 'pipe' }
      );
    },
  };
}

// ── GitHub Store ─────────────────────────────────────────────────────────────

const GH_API = 'https://api.github.com';

export function makeGitHubStore({
  owner = process.env.GITHUB_OWNER || 'wallenut',
  repo = process.env.GITHUB_REPO || 'allen-wiki',
  token = process.env.GITHUB_TOKEN,
} = {}) {
  function url(path) {
    return `${GH_API}/repos/${owner}/${repo}/contents/${path}`;
  }

  function authHeaders() {
    return {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  return {
    async read(path) {
      const res = await fetch(url(path), { headers: authHeaders() });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${path}`);
      const data = await res.json();
      // GitHub returns base64 content, possibly with embedded newlines
      const content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      return { content, sha: data.sha };
    },

    async write(path, { content, message = `memory: update ${path}`, sha } = {}) {
      const b64 = Buffer.from(content, 'utf8').toString('base64');
      const body = { message, content: b64 };
      if (sha !== undefined) body.sha = sha;
      const res = await fetch(url(path), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${path}`);
      const data = await res.json();
      return { sha: data.content?.sha };
    },

    async remove(path, { message = `memory: remove ${path}`, sha } = {}) {
      const body = { message, sha };
      const res = await fetch(url(path), {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`GitHub remove failed: ${res.status} ${path}`);
    },
  };
}
