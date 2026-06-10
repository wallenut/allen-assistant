// The context router (Wallenut Protocol, Batch C step 1).
// Pure logic: given the wiki tree + a query, pick the front door(s) to load —
// the relevant domain(s) plus the always-on synthesis — instead of the whole wiki.
// Open-world by default: domains are discovered by globbing **/current_state.md,
// never from a hardcoded list, so a new projects/<x>/current_state.md is routed
// to with zero code changes.

export const SYNTHESIS = 'allen_synthesis.md'

// Tiny alias seed for the well-known domains, for natural-language terms that
// don't contain the domain name ("pec" -> fitness). New domains need no entry
// here — they still match on their own name token (see classifyDomains).
const ALIASES = {
  fitness: ['pec', 'heal', 'healing', 'recovery', 'rehab', 'lift', 'training', 'workout', 'body', 'injury', 'block'],
  research: ['sloan', 'encoder', 'model', 'paper', 'journal', 'mlsa', 'leuven', 'retrieval', 'club'],
  life: ['china', 'writing', 'essay', 'players', 'return'],
  emergpt: ['client', 'medical', 'practice', 'sam', 'phi', 'consulting'],
}

// 'fitness/current_state.md' -> 'fitness'; 'projects/emerGPT/current_state.md' -> 'emergpt'
export function domainOf(path) {
  const parts = path.split('/')
  if (parts.length < 2) return 'synthesis' // allen_synthesis.md and other top-level files
  return parts[parts.length - 2].toLowerCase()
}

// Glob the flat tree for front doors: every **/current_state.md, plus the synthesis.
export function discoverDoors(paths) {
  const doors = paths.filter(p => p.endsWith('/current_state.md'))
  doors.push(SYNTHESIS) // synthesis is always loaded, whether or not it's in the tree
  return [...new Set(doors)]
}

// Query -> matched domain keys. Name-token match (open-world) OR alias match.
export function classifyDomains(query, doors) {
  const q = query.toLowerCase()
  const keys = doors.map(domainOf).filter(k => k !== 'synthesis')
  return keys.filter(key => q.includes(key) || (ALIASES[key] || []).some(a => q.includes(a)))
}

// Assemble the load set: always the synthesis + every matched domain door.
// No match -> fall back to ALL doors (never strand the user with synthesis alone).
export function selectContext(query, doors, classify = classifyDomains) {
  const matched = classify(query, doors)
  if (matched.length === 0) return [...doors]
  const selected = doors.filter(d => d === SYNTHESIS || matched.includes(domainOf(d)))
  return [...new Set(selected)]
}
