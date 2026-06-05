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
