import { Octokit } from '@octokit/rest'

const octokit = new Octokit({ auth: import.meta.env.VITE_GITHUB_TOKEN })
const [owner, repo] = import.meta.env.VITE_GITHUB_WIKI_REPO.split('/')

export async function writeBuffer(summary, title) {
  const today = new Date().toISOString().split('T')[0]
  const path = `buffer/${today}.md`
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const prefix = title ? `[${time}] **${title}** — ` : `[${time}] `
  const line = `${prefix}${summary}\n\n`

  let sha, existing = ''
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path })
    sha = data.sha
    existing = atob(data.content.replace(/\n/g, ''))
  } catch (e) {
    if (e.status !== 404) throw e
  }

  await octokit.repos.createOrUpdateFileContents({
    owner, repo, path,
    message: `buffer: ${today}`,
    content: btoa(unescape(encodeURIComponent(existing + line))),
    ...(sha ? { sha } : {}),
  })
}
