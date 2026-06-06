const WIKI_FILES = [
  'allen_synthesis.md',
  'research/current_state.md',
  'fitness/current_state.md',
  'life/current_state.md',
  'ops/tasks.md',
  'projects/emerGPT/overview.md',
]

const FALLBACK_PROMPT = `You are Wallenut, Allen Wang's personal AI assistant and second brain.
Be concise, direct, and helpful.`

async function fetchFile(path) {
  const res = await fetch(`/api/wiki/${path}`)
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return res.text()
}

export async function loadWikiContext() {
  const sections = await Promise.allSettled(WIKI_FILES.map(fetchFile))

  sections.forEach((result, i) => {
    if (result.status === 'rejected') console.warn(`Wiki load failed [${WIKI_FILES[i]}]:`, result.reason)
  })

  const body = sections
    .map((result, i) => {
      if (result.status === 'rejected') return null
      return `## ${WIKI_FILES[i]}\n\n${result.value}`
    })
    .filter(Boolean)
    .join('\n\n---\n\n')

  if (!body) return FALLBACK_PROMPT

  return `You are Wallenut, Allen Wang's personal AI assistant and second brain.
Be concise, direct, and helpful. Here is Allen's current context:\n\n${body}`
}
