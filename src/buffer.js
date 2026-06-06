import { sendMessage } from './gemini.js'

const EXTRACTION_PROMPT = `Extract a list of atomic facts, decisions, preferences, and open questions from this conversation. Return ONLY a JSON array of objects with shape {"type": "fact"|"decision"|"preference"|"question", "content": string}. No markdown, no explanation.`

export async function extractFacts(messages) {
  if (!messages || messages.length < 2) return []
  try {
    const transcript = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .join('\n')
    const raw = await sendMessage([], transcript, EXTRACTION_PROMPT)
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch (err) {
    console.error('extractFacts failed:', err)
    return []
  }
}

export async function writeEpisodicBuffer(facts) {
  if (!facts || facts.length === 0) return
  const today = new Date().toISOString().split('T')[0]
  const path = `buffer/${today}.json`
  const ts = new Date().toISOString()
  const newEntries = facts.map(f => ({ ...f, ts }))

  let sha, existing = []
  try {
    const r = await fetch(`/api/buffer/${path}`)
    if (r.ok) {
      const data = await r.json()
      sha = data.sha
      const decoded = atob(data.content.replace(/\n/g, ''))
      existing = JSON.parse(decoded)
      if (!Array.isArray(existing)) existing = []
    }
  } catch {}

  const merged = [...existing, ...newEntries]
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(merged, null, 2))))
  const res = await fetch('/api/buffer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, sha, message: `episodic: ${today}` }),
  })
  if (!res.ok) throw new Error('Episodic buffer write failed')
}

export async function writeBuffer(summary, title) {
  const today = new Date().toISOString().split('T')[0]
  const path = `buffer/${today}.md`
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const prefix = title ? `[${time}] **${title}** — ` : `[${time}] `
  const line = `${prefix}${summary}\n\n`

  let sha, existing = ''
  try {
    const r = await fetch(`/api/buffer/${path}`)
    if (r.ok) {
      const data = await r.json()
      sha = data.sha
      existing = atob(data.content.replace(/\n/g, ''))
    }
  } catch {}

  const content = btoa(unescape(encodeURIComponent(existing + line)))
  const res = await fetch('/api/buffer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, sha, message: `buffer: ${today}` }),
  })
  if (!res.ok) throw new Error('Buffer write failed')
}
