// Deterministic test for P5a episodic buffer capture — NO network, NO API key.
// Creates a temp git repo, calls captureBuffer, verifies the file and the commit.
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBuffer } from './episodic.js';

const FAKE_MESSAGES = [
  { role: 'user', content: 'Hey Wallenut, what is my pec status?' },
  { role: 'assistant', content: 'Based on your wiki, your pec is in the Bridge/Maintenance block.' },
  { role: 'user', content: 'Great, thanks.' },
];

async function run() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'wallenut-test-'));

  try {
    // Set up a bare git repo in tmpDir so commit works.
    execSync(`git init ${JSON.stringify(tmpDir)}`, { stdio: 'pipe' });
    execSync(`git -C ${JSON.stringify(tmpDir)} config user.email "test@wallenut.local"`, { stdio: 'pipe' });
    execSync(`git -C ${JSON.stringify(tmpDir)} config user.name "Wallenut Test"`, { stdio: 'pipe' });

    const result = captureBuffer(FAKE_MESSAGES, tmpDir);

    // Must return appended: true.
    assert.strictEqual(result.appended, true, `Expected appended=true, got: ${JSON.stringify(result)}`);

    // Buffer file must exist.
    const today = new Date().toISOString().slice(0, 10);
    const expectedPath = join(tmpDir, 'buffer', `${today}.md`);
    assert.strictEqual(result.path, expectedPath, 'Returned path matches expected location');

    const contents = readFileSync(expectedPath, 'utf8');

    // File must contain the session turns.
    assert.ok(contents.includes('**user:** Hey Wallenut'), 'user turn present in buffer file');
    assert.ok(contents.includes('**assistant:** Based on your wiki'), 'assistant turn present in buffer file');
    assert.ok(contents.includes('**user:** Great, thanks.'), 'second user turn present in buffer file');

    // Exactly one commit in the repo.
    const log = execSync(`git -C ${JSON.stringify(tmpDir)} log --oneline`, { encoding: 'utf8' }).trim();
    const commits = log.split('\n').filter(Boolean);
    assert.strictEqual(commits.length, 1, `Expected 1 commit, got ${commits.length}: ${log}`);
    assert.ok(commits[0].includes(`buffer: ${today} session`), `Commit message correct: ${commits[0]}`);

    console.log('PASS — episodic buffer capture');
    console.log(`  path=${expectedPath}`);
    console.log(`  commit=${commits[0]}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
