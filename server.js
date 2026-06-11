import 'dotenv/config'
import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

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

// ── Static (prod only) ────────────────────────────────────────────────────────

if (isProd) {
  app.use(express.static(join(__dirname, 'dist')))
  app.get('*', (_, res) => res.sendFile(join(__dirname, 'dist', 'index.html')))
}

app.listen(PORT, () => console.log(`API server on ${PORT}`))
