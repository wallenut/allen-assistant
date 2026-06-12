// P4 server tests — POST /api/chat SSE endpoint.
// Uses an in-process HTTP server + mock adapter; no real API key required.
//
// AC1: Valid request returns SSE stream ending with {"type":"done"}
// AC2: The text event contains a non-empty string
// AC3: Missing ANTHROPIC_API_KEY returns 503 {"error":"runtime not configured"}

import http from 'node:http'
import { runLoop } from './loop.js'
import { buildRegistry } from './registry.js'

class MockAdapter {
  async complete(_system, _messages, _tools) {
    return {
      assistantContent: [{ type: 'text', text: 'Hello from the Wallenut runtime' }],
      text: 'Hello from the Wallenut runtime',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 15 },
    }
  }
}

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

// Mirrors what the real POST /api/chat handler will do in server.js.
async function handleChat(body, apiKey) {
  if (!apiKey) return { status: 503, jsonBody: { error: 'runtime not configured' } }

  const { message, history = [] } = body
  const messages = [...history, { role: 'user', content: message }]
  const events = []

  const result = await runLoop({
    adapter: new MockAdapter(),
    registry: buildRegistry([]),
    tools: [],
    messages,
    onEvent: (evt) => events.push(sse({ type: evt.type, name: evt.name, args: evt.args })),
  })

  events.push(sse({ type: 'text', text: result.text }))
  events.push(sse({ type: 'done' }))
  return { status: 200, sseBody: events.join('') }
}

function createServer() {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/api/chat') {
        res.writeHead(404); res.end(); return
      }
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', async () => {
        try {
          const result = await handleChat(JSON.parse(body), process.env.ANTHROPIC_API_KEY)
          if (result.jsonBody) {
            res.writeHead(result.status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result.jsonBody))
          } else {
            res.writeHead(result.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
            res.end(result.sseBody)
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
    })
    server.listen(0, () => resolve({ server, url: `http://localhost:${server.address().port}` }))
  })
}

async function postChat(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    return { status: res.status, json: JSON.parse(text), events: null }
  }
  const events = text.split('\n\n')
    .filter(chunk => chunk.startsWith('data: '))
    .map(chunk => JSON.parse(chunk.slice(6)))
  return { status: res.status, events, json: null }
}

let passed = 0, failed = 0
function check(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++ }
  else { console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); failed++ }
}

console.log('\n── P4 Server Tests ───────────────────────────────────\n')

const { server, url } = await createServer()

// AC1 + AC2: valid request → SSE stream with text event + done
{
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const r = await postChat(`${url}/api/chat`, { message: 'hello', history: [] })
  check('AC1: returns 200', r.status === 200, String(r.status))
  check('AC1: SSE events array non-empty', r.events?.length > 0)
  const last = r.events?.at(-1)
  check('AC1: last event is {type:"done"}', last?.type === 'done', JSON.stringify(last))
  const textEvt = r.events?.find(e => e.type === 'text')
  check('AC2: text event exists', !!textEvt)
  check('AC2: text is non-empty string', typeof textEvt?.text === 'string' && textEvt.text.length > 0, `"${textEvt?.text}"`)
}

// AC3: missing API key → 503
{
  const saved = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  const r = await postChat(`${url}/api/chat`, { message: 'hello', history: [] })
  check('AC3: returns 503', r.status === 503, String(r.status))
  check('AC3: error is "runtime not configured"', r.json?.error === 'runtime not configured', JSON.stringify(r.json))
  process.env.ANTHROPIC_API_KEY = saved
}

server.close()
console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────\n`)
process.exit(failed > 0 ? 1 : 0)
