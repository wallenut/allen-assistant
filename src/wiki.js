import { Octokit } from '@octokit/rest'

const octokit = new Octokit({ auth: import.meta.env.VITE_GITHUB_TOKEN })

const [owner, repo] = import.meta.env.VITE_GITHUB_WIKI_REPO.split('/')

const WIKI_FILES = [
  'allen_synthesis.md',
  'research/current_state.md',
  'fitness/current_state.md',
  'life/current_state.md',
  'ops/tasks.md',
]

const FALLBACK_PROMPT = `You are Wallenut, Allen Wang's personal AI assistant and second brain.
Be concise, direct, and helpful.`

async function fetchFile(path) {
  const { data } = await octokit.repos.getContent({ owner, repo, path })
  return atob(data.content.replace(/\n/g, ''))
}

export async function loadWikiContext() {
  const sections = await Promise.allSettled(WIKI_FILES.map(fetchFile))

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
