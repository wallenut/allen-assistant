import { discoverDoors, selectContext } from './wikiContext.js'

const FALLBACK_PROMPT = `You are Wallenut, Allen Wang's personal AI assistant and second brain.
Be concise, direct, and helpful.`

const PREAMBLE = `You are Wallenut, Allen Wang's personal AI assistant and second brain.
Be concise, direct, and helpful. Here is Allen's current context:`

async function fetchFile(path) {
  const res = await fetch(`/api/wiki/${path}`)
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return res.text()
}

async function fetchTree() {
  const res = await fetch('/api/wiki-tree')
  if (!res.ok) throw new Error(`tree ${res.status}`)
  return res.json()
}

// Discover the front doors, fetch their contents once, and return a per-query
// builder that loads only the door(s) the query is about (always + synthesis).
// On any failure it returns a builder that yields the fallback prompt — the UI
// must never block on the wiki.
export async function initWikiContext() {
  let doors
  try {
    doors = discoverDoors(await fetchTree())
  } catch (err) {
    console.warn('Wiki tree load failed:', err.message)
    return () => FALLBACK_PROMPT
  }

  const entries = await Promise.allSettled(doors.map(async d => [d, await fetchFile(d)]))
  const cache = {}
  entries.forEach((r, i) => {
    if (r.status === 'fulfilled') cache[r.value[0]] = r.value[1]
    else console.warn(`Wiki load failed [${doors[i]}]:`, r.reason)
  })

  const loaded = doors.filter(d => cache[d] != null)
  if (loaded.length === 0) return () => FALLBACK_PROMPT

  return function buildPrompt(query) {
    const selected = selectContext(query || '', loaded)
    const body = selected.map(path => `## ${path}\n\n${cache[path]}`).join('\n\n---\n\n')
    return `${PREAMBLE}\n\n${body}`
  }
}
