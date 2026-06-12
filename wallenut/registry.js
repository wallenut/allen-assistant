import { read } from './tools/read.js';
import { write } from './tools/write.js';
import { edit } from './tools/edit.js';
import { makeBash } from './tools/bash.js';
import { webSearch } from './tools/web_search.js';

// Build a name -> tool registry once from an array of tools.
export function buildRegistry(tools) {
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

// The default v1 tool set. `confirm` is injectable for the bash gate (tests pass auto-confirm).
export function defaultTools(confirm) {
  return [read, write, edit, makeBash(confirm), webSearch];
}
