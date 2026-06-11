import { readFile } from 'node:fs/promises';

export const read = {
  name: 'read',
  description: 'Read a file from the local filesystem. Returns the contents with line numbers (like `cat -n`).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read.' },
    },
    required: ['path'],
  },
  async run({ path }) {
    if (!path) return 'Error: read requires a "path".';
    try {
      const content = await readFile(path, 'utf8');
      const lines = content.split('\n');
      // Drop the trailing empty element from a final newline so we don't number a phantom line.
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const width = String(lines.length).length;
      return lines.map((l, i) => `${String(i + 1).padStart(width)}\t${l}`).join('\n');
    } catch (err) {
      return `Error reading ${path}: ${err.message}`;
    }
  },
};
