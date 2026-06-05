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

app.get('/api/ping', (_, res) => res.json({ ok: true }))

// ── Wiki proxy ────────────────────────────────────────────────────────────────

app.use('/api/wiki', async (req, res) => {
  try {
    const path = req.path.replace(/^\//, '')
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`
    const r = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } })
    if (!r.ok) {
      console.error(`GitHub fetch failed: ${r.status} ${url} token=${GITHUB_TOKEN ? GITHUB_TOKEN.slice(0,8) + '...' : 'MISSING'}`)
      return res.status(r.status).end()
    }
    const text = await r.text()
    res.type('text/plain').send(text)
  } catch (err) {
    console.error('Wiki proxy error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Buffer read ───────────────────────────────────────────────────────────────

app.get('/api/buffer/*', async (req, res) => {
  try {
    const path = req.path.replace(/^\//, '')
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
    const r = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } })
    if (!r.ok) return res.status(r.status).end()
    res.json(await r.json())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Buffer write ──────────────────────────────────────────────────────────────

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

// ── Static (prod only) ────────────────────────────────────────────────────────

if (isProd) {
  app.use(express.static(join(__dirname, 'dist')))
  app.get('*', (_, res) => res.sendFile(join(__dirname, 'dist', 'index.html')))
}

app.listen(PORT, () => console.log(`API server on ${PORT}`))
