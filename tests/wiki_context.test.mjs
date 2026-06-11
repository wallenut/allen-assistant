// Acceptance criteria — the context router (Wallenut Protocol, Batch C step 1):
// 1. discoverDoors globs **/current_state.md and always adds allen_synthesis.md
//    (open-world: no hardcoded domain list; raw/ history and non-doors excluded)
// 2. domainOf derives a stable domain key from a door path
// 3. selectContext ALWAYS includes the synthesis front door
// 4. selectContext routes a query to its domain door(s) (incl. alias terms like "pec" -> fitness)
// 5. A query with no domain signal falls back to ALL doors (never strand the user with synthesis-only)
// 6. Selection is always a subset of available doors, with no duplicates
// 7. Open-world: a brand-new projects/<x>/current_state.md routes by its name token with zero config

import { discoverDoors, domainOf, selectContext, classifyDomains, domainPaths, SYNTHESIS } from '../src/wikiContext.js';

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const hasDupes = (a) => new Set(a).size !== a.length;

console.log('\n── Wiki Context Router Tests ──────────────────────\n');

// A realistic flat listing of the wiki tree (what the GitHub tree API returns)
const tree = [
  'allen_synthesis.md',
  'research/current_state.md',
  'research/raw/2026-06-05_research_current_state.md',
  'fitness/current_state.md',
  'fitness/raw/2026-06-05_fitness_current_state.md',
  'life/current_state.md',
  'projects/emerGPT/current_state.md',
  'ops/tasks.md',
  'README.md',
];

// AC1: discovery globs current_state.md + always-on synthesis, excludes raw/ and non-doors
const doors = discoverDoors(tree);
assert('discoverDoors includes the synthesis front door', doors.includes(SYNTHESIS));
assert('discoverDoors finds every **/current_state.md', sameSet(doors, [
  'allen_synthesis.md',
  'research/current_state.md',
  'fitness/current_state.md',
  'life/current_state.md',
  'projects/emerGPT/current_state.md',
]), doors.join(', '));
assert('discoverDoors excludes raw/ history and non-door files', !doors.some(d => d.includes('/raw/') || d === 'README.md' || d === 'ops/tasks.md'));

// AC2: domain key derivation
assert('domainOf(fitness) -> fitness', domainOf('fitness/current_state.md') === 'fitness');
assert('domainOf(nested project) -> leaf folder', domainOf('projects/emerGPT/current_state.md') === 'emergpt');

// AC3 + AC4: synthesis always present; queries route to their domain
const fit = selectContext('how is my pec healing after the block?', doors);
assert('selectContext always includes synthesis', fit.includes(SYNTHESIS));
assert('"pec healing" routes to fitness (alias match)', fit.includes('fitness/current_state.md'), fit.join(', '));
assert('"pec healing" does NOT pull unrelated doors', !fit.includes('research/current_state.md'));

const res = selectContext("what's the Sloan positioning for my encoder paper?", doors);
assert('"Sloan / encoder" routes to research', res.includes('research/current_state.md'), res.join(', '));

const emer = selectContext('how is emerGPT going this week?', doors);
assert('"emerGPT" routes to its door by name token', emer.includes('projects/emerGPT/current_state.md'), emer.join(', '));

// AC5: no domain signal -> safe fallback to ALL doors (not synthesis-only)
const vague = selectContext('hey, give me a quick rundown of everything', doors);
assert('no-signal query falls back to all doors', sameSet(vague, doors), vague.join(', '));

// AC6: subset + no duplicates, on every selection
for (const sel of [fit, res, emer, vague]) {
  assert('selection is a subset of available doors', sel.every(d => doors.includes(d)));
  assert('selection has no duplicates', !hasDupes(sel));
}

// AC7: open-world — a new domain is routable by its name token with zero config
const grownTree = [...tree, 'projects/jarvis/current_state.md'];
const grownDoors = discoverDoors(grownTree);
assert('new domain is discovered by the glob', grownDoors.includes('projects/jarvis/current_state.md'));
const jarvis = selectContext('what is left on the jarvis roadmap?', grownDoors);
assert('new domain routes by name token, no alias needed', jarvis.includes('projects/jarvis/current_state.md'), jarvis.join(', '));

// AC8: domainPaths backs the read_wiki tool — maps each loadable domain to its door,
//      excludes synthesis (always present, not a fetchable "domain"), and is the enum
//      of valid tool arguments. Resolution is case-insensitive on the domain name.
const dp = domainPaths(doors);
assert('domainPaths maps domain -> door path', dp.fitness === 'fitness/current_state.md');
assert('domainPaths resolves nested project domain', dp.emergpt === 'projects/emerGPT/current_state.md');
assert('domainPaths excludes synthesis (not a fetchable domain)', !('synthesis' in dp));
assert('domainPaths keys cover every non-synthesis door', sameSet(
  Object.keys(dp),
  doors.filter(d => d !== SYNTHESIS).map(domainOf)
), Object.keys(dp).join(', '));

// AC9: routing matches whole words, not substrings — a domain name embedded in an
//      unrelated word must NOT route ("wildlife" must not pull the life door).
assert('"wildlife" does NOT route to life (word boundary)', !classifyDomains('I saw wildlife today', doors).includes('life'));
assert('"my life lately" DOES route to life', classifyDomains('how is my life lately?', doors).includes('life'));

// AC10: raw/ history files are never treated as front doors, even if named current_state.md.
const rawTree = ['fitness/current_state.md', 'fitness/raw/current_state.md', 'allen_synthesis.md'];
assert('discoverDoors excludes /raw/ paths', sameSet(discoverDoors(rawTree),
  ['fitness/current_state.md', 'allen_synthesis.md']), discoverDoors(rawTree).join(', '));

console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────\n`);
process.exit(failed > 0 ? 1 : 0);
