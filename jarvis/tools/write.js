import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const write = {
  name: 'write',
  description: 'Write a file to the local filesystem, creating parent directories as needed. Overwrites if it exists.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write.' },
      content: { type: 'string', description: 'The full contents to write.' },
    },
    required: ['path', 'content'],
  },
  async run({ path, content }) {
    if (!path) return 'Error: write requires a "path".';
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content ?? '', 'utf8');
      return `Wrote ${Buffer.byteLength(content ?? '')} bytes to ${path}.`;
    } catch (err) {
      return `Error writing ${path}: ${err.message}`;
    }
  },
};
