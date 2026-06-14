// src/buffer.js — browser-side capture surface.
// captureSession() is the public entrypoint; it POSTs the transcript to
// /api/capture, which calls memory.js directly (not the agent loop).

// DEPRECATED 2026-06-14: superseded by /api/capture (memory spine v2)
// The old extractFacts / writeEpisodicBuffer are replaced by captureToServer.
// writeBuffer (.md) is kept for reference but is no longer called.

/**
 * Send a transcript to the server for fact extraction + buffer write.
 * Returns { count: number } on success.
 * THROWS on non-2xx response so App.jsx can surface the error.
 *
 * @param {Array} messages - conversation messages array (role + text fields)
 * @returns {Promise<{ count: number }>}
 */
export async function captureToServer(messages) {
  // Browser messages are { role, text }; memory.js's extractFacts reads `content`.
  // Map at this boundary so the server-side core gets its expected shape.
  const mapped = (messages || []).map(m => ({ role: m.role, content: m.text ?? m.content ?? '' }))
  const res = await fetch('/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: mapped }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Capture failed: ${res.status}`)
  }
  return res.json()
}

// ── DEPRECATED (old Gemini-based extraction) ─────────────────────────────────

// DEPRECATED 2026-06-14: replaced by captureToServer → /api/capture
export async function extractFacts(_messages) {
  console.warn('buffer.js extractFacts is deprecated; use captureToServer')
  return []
}

// DEPRECATED 2026-06-14: replaced by captureToServer → /api/capture
export async function writeEpisodicBuffer(_facts) {
  console.warn('buffer.js writeEpisodicBuffer is deprecated; use captureToServer')
}

// DEPRECATED 2026-06-14: .md buffer write superseded by .json fact extraction
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
