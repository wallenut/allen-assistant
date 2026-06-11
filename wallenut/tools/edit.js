import { readFile, writeFile } from 'node:fs/promises';

export const edit = {
  name: 'edit',
  description: 'Replace an exact string in a file. The old_string must appear exactly once.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace (must be unique in the file).' },
      new_string: { type: 'string', description: 'Text to replace it with.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run({ path, old_string, new_string }) {
    if (!path) return 'Error: edit requires a "path".';
    if (old_string == null) return 'Error: edit requires an "old_string".';
    try {
      const content = await readFile(path, 'utf8');
      const first = content.indexOf(old_string);
      if (first === -1) return `Error: old_string not found in ${path}.`;
      if (content.indexOf(old_string, first + 1) !== -1)
        return `Error: old_string is not unique in ${path}; it appears multiple times.`;
      await writeFile(path, content.replace(old_string, new_string ?? ''), 'utf8');
      return `Edited ${path}.`;
    } catch (err) {
      return `Error editing ${path}: ${err.message}`;
    }
  },
};
