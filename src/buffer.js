// src/buffer.js — browser-side capture surface.
// captureToServer POSTs the transcript to /api/capture, which calls memory.js
// directly (not the agent loop). This is the only browser capture path.

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
