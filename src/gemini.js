// P4: transport shim — routes chat through the Wallenut runtime via POST /api/chat (SSE).
// Keeps the same function signature as the old Gemini client so App.jsx requires no changes.

export async function sendMessage(history, text, systemPrompt) {
  const mappedHistory = (history || []).map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.text,
  }))

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, history: mappedHistory, systemPrompt }),
  })

  if (!res.ok) {
    throw new Error(`/api/chat returned ${res.status}`)
  }

  // Parse SSE stream: collect all {"type":"text"} chunks and concatenate.
  const body = await res.text()
  const parts = body
    .split('\n\n')
    .filter(chunk => chunk.startsWith('data: '))
    .map(chunk => {
      try { return JSON.parse(chunk.slice(6)) } catch { return null }
    })
    .filter(Boolean)

  const textParts = parts.filter(e => e.type === 'text').map(e => e.text)
  if (textParts.length === 0) {
    throw new Error('No text in /api/chat response')
  }
  return textParts.join('')
}
