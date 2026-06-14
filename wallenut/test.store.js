// TDD tests for wallenut/store.js — no real network calls.
// makeLocalGitStore: uses a real temp git repo.
// makeGitHubStore: global fetch is mocked; no network.
// Run: node wallenut/test.store.js
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { makeLocalGitStore, makeGitHubStore } from './store.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
    failed++;
  }
}

// ── makeLocalGitStore ─────────────────────────────────────────────────────

function makeTempRepo() {
  const dir = mkdtempSync(`${tmpdir()}/wallenut-store-test-`);
  execSync(`git init ${JSON.stringify(dir)}`, { stdio: 'pipe' });
  execSync(`git -C ${JSON.stringify(dir)} config user.email "test@wallenut.local"`, { stdio: 'pipe' });
  execSync(`git -C ${JSON.stringify(dir)} config user.name "Wallenut Test"`, { stdio: 'pipe' });
  return dir;
}

await test('makeLocalGitStore: read returns null for missing file', async () => {
  const dir = makeTempRepo();
  try {
    const store = makeLocalGitStore({ wikiDir: dir });
    const result = await store.read('nonexistent.md');
    assert.strictEqual(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('makeLocalGitStore: write→read round-trip', async () => {
  const dir = makeTempRepo();
  try {
    const store = makeLocalGitStore({ wikiDir: dir });
    await store.write('fitness/current_state.md', {
      content: '# Fitness\n- pec work\n',
      message: 'test: write fitness',
    });
    const result = await store.read('fitness/current_state.md');
    assert.ok(result, 'read should return an object');
    assert.strictEqual(result.content, '# Fitness\n- pec work\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('makeLocalGitStore: write commits to git', async () => {
  const dir = makeTempRepo();
  try {
    const store = makeLocalGitStore({ wikiDir: dir });
    await store.write('test.md', { content: 'hello', message: 'add test.md' });
    const log = execSync(`git -C ${JSON.stringify(dir)} log --oneline`, { encoding: 'utf8' }).trim();
    const commits = log.split('\n').filter(Boolean);
    assert.strictEqual(commits.length, 1, 'exactly one commit');
    assert.ok(commits[0].includes('add test.md'), `commit message correct: ${commits[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('makeLocalGitStore: write→remove removes file and commits', async () => {
  const dir = makeTempRepo();
  try {
    const store = makeLocalGitStore({ wikiDir: dir });
    await store.write('to-delete.md', { content: 'bye', message: 'add to-delete' });
    await store.remove('to-delete.md', { message: 'remove to-delete' });
    const after = await store.read('to-delete.md');
    assert.strictEqual(after, null, 'file should be gone');
    const log = execSync(`git -C ${JSON.stringify(dir)} log --oneline`, { encoding: 'utf8' }).trim();
    const commits = log.split('\n').filter(Boolean);
    assert.strictEqual(commits.length, 2, '2 commits total');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('makeLocalGitStore: write creates nested dirs', async () => {
  const dir = makeTempRepo();
  try {
    const store = makeLocalGitStore({ wikiDir: dir });
    await store.write('buffer/2026-06-14.json', { content: '[]', message: 'add buffer' });
    const result = await store.read('buffer/2026-06-14.json');
    assert.strictEqual(result.content, '[]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('makeLocalGitStore: write overwrites existing file and makes new commit', async () => {
  const dir = makeTempRepo();
  try {
    const store = makeLocalGitStore({ wikiDir: dir });
    await store.write('notes.md', { content: 'v1', message: 'add notes' });
    await store.write('notes.md', { content: 'v2', message: 'update notes' });
    const result = await store.read('notes.md');
    assert.strictEqual(result.content, 'v2');
    const log = execSync(`git -C ${JSON.stringify(dir)} log --oneline`, { encoding: 'utf8' }).trim();
    assert.strictEqual(log.split('\n').filter(Boolean).length, 2, '2 commits');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── makeGitHubStore ───────────────────────────────────────────────────────
// Mock global fetch to intercept calls; no real network.

function withMockFetch(mockImpl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = mockImpl;
  return fn().finally(() => {
    if (orig === undefined) delete globalThis.fetch;
    else globalThis.fetch = orig;
  });
}

function b64(str) {
  return Buffer.from(str).toString('base64');
}

await test('makeGitHubStore: read calls correct GET URL and returns content', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url, method: opts?.method || 'GET' });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: b64('# Fitness') + '\n', // GitHub API adds newlines in base64
        sha: 'abc123',
      }),
    };
  }, async () => {
    const store = makeGitHubStore({ owner: 'wallenut', repo: 'allen-wiki', token: 'tok' });
    const result = await store.read('fitness/current_state.md');
    assert.ok(result, 'result not null');
    assert.strictEqual(result.sha, 'abc123');
    assert.ok(result.content.includes('# Fitness'));
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes('fitness/current_state.md'), `URL includes path: ${calls[0].url}`);
    assert.ok(calls[0].url.includes('wallenut/allen-wiki'), `URL includes repo: ${calls[0].url}`);
    assert.strictEqual(calls[0].method, 'GET');
  });
});

await test('makeGitHubStore: read returns null on 404', async () => {
  await withMockFetch(async () => ({
    ok: false,
    status: 404,
    json: async () => ({ message: 'Not Found' }),
  }), async () => {
    const store = makeGitHubStore({ owner: 'wallenut', repo: 'allen-wiki', token: 'tok' });
    const result = await store.read('no/such/file.md');
    assert.strictEqual(result, null);
  });
});

await test('makeGitHubStore: write sends PUT with correct URL, method, body', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: { sha: 'newsha' } }),
    };
  }, async () => {
    const store = makeGitHubStore({ owner: 'wallenut', repo: 'allen-wiki', token: 'tok' });
    const result = await store.write('buffer/2026-06-14.json', {
      content: '[{"type":"fact"}]',
      message: 'episodic: 2026-06-14',
      sha: 'oldsha',
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'PUT');
    assert.ok(calls[0].url.includes('buffer/2026-06-14.json'), `URL correct: ${calls[0].url}`);
    assert.strictEqual(calls[0].body.message, 'episodic: 2026-06-14');
    assert.strictEqual(calls[0].body.sha, 'oldsha');
    // content must be base64-encoded
    const decoded = Buffer.from(calls[0].body.content, 'base64').toString('utf8');
    assert.strictEqual(decoded, '[{"type":"fact"}]');
    assert.ok(result.sha, 'returns sha');
  });
});

await test('makeGitHubStore: write without sha (new file) sends PUT without sha field', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return {
      ok: true, status: 201,
      json: async () => ({ content: { sha: 'created-sha' } }),
    };
  }, async () => {
    const store = makeGitHubStore({ owner: 'wallenut', repo: 'allen-wiki', token: 'tok' });
    await store.write('new-file.md', { content: 'hello', message: 'create new-file' });
    assert.ok(!('sha' in calls[0]) || calls[0].sha === undefined, 'no sha in body for new file');
  });
});

await test('makeGitHubStore: remove sends DELETE with correct URL, method, body', async () => {
  const calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  }, async () => {
    const store = makeGitHubStore({ owner: 'wallenut', repo: 'allen-wiki', token: 'tok' });
    await store.remove('old/file.md', { message: 'remove old file', sha: 'sha999' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'DELETE');
    assert.ok(calls[0].url.includes('old/file.md'), `URL correct: ${calls[0].url}`);
    assert.strictEqual(calls[0].body.sha, 'sha999');
    assert.strictEqual(calls[0].body.message, 'remove old file');
  });
});

await test('makeGitHubStore: write uses Authorization header with token', async () => {
  const headers = [];
  await withMockFetch(async (_url, opts) => {
    headers.push(opts.headers || {});
    return {
      ok: true, status: 200,
      json: async () => ({ content: { sha: 'x' } }),
    };
  }, async () => {
    const store = makeGitHubStore({ owner: 'wallenut', repo: 'allen-wiki', token: 'mytoken' });
    await store.write('x.md', { content: 'x', message: 'x' });
    const auth = headers[0].Authorization || headers[0].authorization || '';
    assert.ok(auth.includes('mytoken'), `Authorization header should contain token: ${auth}`);
  });
});

// ─── summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
