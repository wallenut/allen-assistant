import { exec } from 'node:child_process';

const MAX_OUTPUT = 30_000;
const TIMEOUT_MS = 120_000;

// Default confirm: auto-approve if WALLENUT_AUTO_CONFIRM=1, else prompt y/n on REPL stdin.
async function defaultConfirm(cmd) {
  if (process.env.WALLENUT_AUTO_CONFIRM === '1') return true;
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) =>
      rl.question(`\n  run bash: ${cmd}\n  approve? [y/N] `, resolve)
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// Factory: build the bash tool with an injectable async confirm(cmd) => boolean.
// Injection lets tests auto-confirm without touching stdin.
export function makeBash(confirm = defaultConfirm) {
  return {
    name: 'bash',
    description: 'Run a shell command in the current working directory and return its stdout + stderr. Requires human confirmation.',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The shell command to run.' },
      },
      required: ['cmd'],
    },
    async run({ cmd }) {
      if (!cmd || !String(cmd).trim()) return 'Error: bash requires a non-empty "cmd".';
      let approved;
      try {
        approved = await confirm(cmd);
      } catch (err) {
        return `Error during confirmation: ${err.message}`;
      }
      if (!approved) return 'Command declined by user.';

      return new Promise((resolve) => {
        exec(cmd, { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          let out = (stdout || '') + (stderr || '');
          if (err && err.killed) out += `\n[command timed out after ${TIMEOUT_MS}ms]`;
          else if (err && typeof err.code === 'number') out += `\n[exit code ${err.code}]`;
          if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + '\n[output truncated]';
          resolve(out.length ? out : '[no output]');
        });
      });
    },
  };
}
