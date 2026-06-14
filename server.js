import 'dotenv/config'
import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runLoop } from './wallenut/loop.js'
import { ClaudeAdapter } from './wallenut/adapters/claude.js'
import { assembleSystem, BASE_PROMPT } from './wallenut/context.js'
import { discoverDoors, selectContext } from './src/wikiContext.js'
import { buildRegistry } from './wallenut/registry.js'
import { webSearch } from './wallenut/tools/web_search.js'
import { extractFacts, writeBufferFacts, readBufferFacts, proposePromotion, applyPromotion } from './wallenut/memory.js'
import { makeGitHubStore } from './wallenut/store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isProd = process.env.NODE_ENV === 'production'
const PORT = process.env.PORT || (isProd ? 3000 : 3001)

const GITHUB_TOKEN = process.env.VITE_GITHUB_TOKEN
const WIKI_REPO = process.env.VITE_GITHUB_WIKI_REPO || 'wallenut/allen-wiki'
const [owner, repo] = WIKI_REPO.split('/')

const app = express()
app.use(express.json())

// ── Wiki proxy ────────────────────────────────────────────────────────────────

app.use('/api/wiki', async (req, res) => {
  try {
    const path = req.path.replace(/^\//, '')
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`
    const r = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } })
    if (!r.ok) return res.status(r.status).end()
    const text = await r.text()
    res.type('text/plain').send(text)
  } catch (err) {
    console.error('Wiki proxy error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Flat list of wiki paths — the open-world discovery surface for the context router.
app.get('/api/wiki-tree', async (req, res) => {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`
    const r = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } })
    if (!r.ok) return res.status(r.status).end()
    const data = await r.json()
    res.json((data.tree || []).filter(n => n.type === 'blob').map(n => n.path))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Buffer read / write ───────────────────────────────────────────────────────
// DEPRECATED 2026-06-14: superseded by /api/capture + /api/promote/* (memory spine v2)

app.use('/api/buffer', async (req, res, next) => {
  if (req.method === 'GET') {
    try {
      const path = req.path.replace(/^\//, '')
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
      const r = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } })
      if (!r.ok) return res.status(r.status).end()
      res.json(await r.json())
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  } else {
    next()
  }
})

app.post('/api/buffer', async (req, res) => {
  try {
    const { path, content, sha, message } = req.body
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
    const r = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content, ...(sha ? { sha } : {}) }),
    })
    res.status(r.status).json(await r.json())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Wiki write ────────────────────────────────────────────────────────────────

app.post('/api/wiki-write', async (req, res) => {
  try {
    const { path, content } = req.body
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
    let sha
    try {
      const r = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } })
      if (r.ok) { const d = await r.json(); sha = d.sha }
    } catch {}
    const r = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `wallenut: update ${path}`, content: btoa(unescape(encodeURIComponent(content))), ...(sha ? { sha } : {}) }),
    })
    res.status(r.status).json(await r.json())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Buffer move (to reviewed/) ────────────────────────────────────────────────
// DEPRECATED 2026-06-14: superseded by /api/capture + /api/promote/* (memory spine v2)

app.post('/api/buffer-move', async (req, res) => {
  try {
    const { date } = req.body
    const srcPath = `buffer/${date}.md`
    const dstPath = `buffer/reviewed/${date}.md`

    // Read source
    const srcUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${srcPath}`
    const srcRes = await fetch(srcUrl, { headers: { Authorization: `token ${GITHUB_TOKEN}` } })
    if (!srcRes.ok) return res.status(srcRes.status).end()
    const src = await srcRes.json()

    // Create destination
    const dstUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dstPath}`
    await fetch(dstUrl, {
      method: 'PUT',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `buffer: reviewed ${date}`, content: src.content.replace(/\n/g, '') }),
    })

    // Delete source
    await fetch(srcUrl, {
      method: 'DELETE',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `buffer: archive ${date}`, sha: src.sha }),
    })

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Memory spine (v2) ────────────────────────────────────────────────────────
// Dedicated endpoints that call memory.js directly — NOT through the agent loop.

// Build shared resources once at module load. Store and llm shim are only
// used when ANTHROPIC_API_KEY is set (Railway). Locally the endpoints will
// error on the LLM call — that's expected and intentional.
const _memStore = makeGitHubStore({ owner, repo, token: GITHUB_TOKEN })

function _makeLlm() {
  const adapter = new ClaudeAdapter()
  return async (system, user) =>
    (await adapter.complete(system, [{ role: 'user', content: user }], [])).text
}

// POST /api/capture — body: { messages }
// Extracts facts from the transcript and appends to buffer/{today}.json.
// Returns: { count: number }
app.post('/api/capture', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'runtime not configured' })
  }
  try {
    const { messages } = req.body
    const llm = _makeLlm()
    const facts = await extractFacts(messages, { llm })
    await writeBufferFacts(facts, { store: _memStore })
    res.json({ count: facts.length })
  } catch (err) {
    console.error('POST /api/capture error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/promote/propose — body: { date? }
// Reads buffer/{date}.json, fetches wiki tree, proposes promotion edits.
// Returns: { proposals }
app.post('/api/promote/propose', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'runtime not configured' })
  }
  try {
    const date = req.body?.date || new Date().toISOString().slice(0, 10)
    const facts = await readBufferFacts(date, { store: _memStore })

    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`
    const treeRes = await fetch(treeUrl, { headers: { Authorization: `token ${GITHUB_TOKEN}` } })
    const treeData = treeRes.ok ? await treeRes.json() : { tree: [] }
    const wikiFiles = (treeData.tree || []).filter(n => n.type === 'blob').map(n => n.path)

    const today = new Date().toISOString().slice(0, 10)
    const llm = _makeLlm()
    const proposals = await proposePromotion(facts, { llm, store: _memStore, wikiFiles, today })
    res.json({ proposals })
  } catch (err) {
    console.error('POST /api/promote/propose error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/promote/apply — body: { approved, date?, archive? }
// Applies approved proposals to wiki files. Does NOT archive the buffer by
// default — un-promoted facts stay live in buffer/{date}.json for re-review.
// Pass archive:true to explicitly move the buffer to reviewed/ when done.
// Returns: { summary }
app.post('/api/promote/apply', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'runtime not configured' })
  }
  try {
    const { approved = [], archive = false } = req.body
    const date = req.body?.date || new Date().toISOString().slice(0, 10)

    const summary = await applyPromotion(approved, { store: _memStore })

    // Archive only when explicitly requested — never silently shelve un-promoted facts.
    if (archive) {
      const srcPath = `buffer/${date}.json`
      const dstPath = `buffer/reviewed/${date}.json`
      const src = await _memStore.read(srcPath)
      if (src) {
        await _memStore.write(dstPath, { content: src.content, message: `buffer: reviewed ${date}`, sha: undefined })
        await _memStore.remove(srcPath, { message: `buffer: archive ${date}`, sha: src.sha })
      }
    }

    res.json({ summary })
  } catch (err) {
    console.error('POST /api/promote/apply error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Wiki context via GitHub API (fallback when local wiki clone is absent) ────
// Same logic as wallenut/context.js assembleSystem but fetches from GitHub.
// Used on Railway where ~/allen-wiki doesn't exist.

async function buildSystemFromGitHub(query) {
  try {
    console.log('[wiki-gh] fetching tree for query:', query.slice(0, 60))
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`
    const treeRes = await fetch(treeUrl, { headers: { Authorization: `token ${GITHUB_TOKEN}` } })
    console.log('[wiki-gh] tree status:', treeRes.status, 'token set:', !!GITHUB_TOKEN)
    if (!treeRes.ok) return BASE_PROMPT
    const treeData = await treeRes.json()
    const paths = (treeData.tree || []).filter(n => n.type === 'blob').map(n => n.path)

    const doors = discoverDoors(paths)
    const selected = selectContext(query, doors)
    console.log('[wiki-gh] doors:', doors.length, 'selected:', selected)

    const blocks = []
    for (const rel of selected) {
      const fileRes = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/main/${rel}`,
        { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
      )
      console.log('[wiki-gh] file', rel, '→', fileRes.status)
      if (fileRes.ok) blocks.push(`## ${rel}\n${await fileRes.text()}`)
    }

    console.log('[wiki-gh] blocks loaded:', blocks.length)
    if (blocks.length === 0) return BASE_PROMPT
    return BASE_PROMPT +
      `\nWiki directory: GitHub (${owner}/${repo})` +
      "\n\n# Allen's wiki context (routed for this turn)\n\n" +
      blocks.join('\n\n')
  } catch (err) {
    console.error('[wiki-gh] error:', err.message)
    return BASE_PROMPT
  }
}

// ── Chat (Wallenut runtime) ───────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'runtime not configured' })
  }

  const { message, history = [], systemPrompt } = req.body
  const messages = [...history, { role: 'user', content: message }]

  // Trust the browser-built systemPrompt (src/wiki.js already loaded wiki via /api/wiki).
  // Only run server-side assembly when no systemPrompt provided (CLI / direct callers).
  let system = systemPrompt || await assembleSystem(message).catch(() => null)
  if (!system || !system.includes("Allen's wiki context")) {
    system = await buildSystemFromGitHub(message)
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  function sendEvent(obj) {
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  try {
    const adapter = new ClaudeAdapter()
    const tools = [webSearch]
    const registry = buildRegistry(tools)

    const result = await runLoop({
      adapter,
      registry,
      tools,
      messages,
      system,
      onEvent: (evt) => {
        if (evt.type === 'tool_call') sendEvent({ type: 'tool_call', name: evt.name, args: evt.args })
        else if (evt.type === 'tool_result') sendEvent({ type: 'tool_result', name: evt.name, result: evt.result })
      },
    })

    sendEvent({ type: 'text', text: result.text })
    sendEvent({ type: 'done' })
    res.end()
  } catch (err) {
    console.error('runLoop error:', err)
    sendEvent({ type: 'done' })
    res.end()
  }
})

// ── Static (prod only) ────────────────────────────────────────────────────────

if (isProd) {
  app.use(express.static(join(__dirname, 'dist')))
  app.get('*', (_, res) => res.sendFile(join(__dirname, 'dist', 'index.html')))
}

app.listen(PORT, () => console.log(`API server on ${PORT}`))
