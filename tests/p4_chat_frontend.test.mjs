// P4 frontend tests — verifies the React app routes chat through /api/chat (the
// Wallenut runtime) instead of calling Gemini directly from the browser.
//
// AC4: Submitting a message sends POST /api/chat, NOT generativelanguage.googleapis.com
// AC5: Mock SSE response is rendered in the chat UI
// AC6: Capture button still appears after 2+ exchanges (no regression)

import { chromium } from 'playwright'

const BASE_URL = 'http://localhost:5175'
const PASSWORD = process.env.VITE_APP_PASSWORD || 'wheelbrother'

function sseBody(text) {
  return `data: ${JSON.stringify({ type: 'text', text })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`
}

let passed = 0, failed = 0
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++ }
  else { console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); failed++ }
}

console.log('\n── P4 Chat Frontend Tests ────────────────────────────\n')

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

const chatRequests = []
const geminiBadRequests = []

// Mock the runtime chat endpoint — returns a synthetic SSE response.
await page.route('**/api/chat', (route) => {
  chatRequests.push({ url: route.request().url(), method: route.request().method() })
  route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: sseBody('Hello from Wallenut runtime'),
  })
})

// Any Gemini call for chat is a regression — intercept and fail it.
await page.route('**/generativelanguage.googleapis.com/**', (route) => {
  geminiBadRequests.push(route.request().url())
  route.abort()
})

// Login
await page.goto(BASE_URL)
await page.fill('input[type="password"]', PASSWORD)
await page.keyboard.press('Enter')
await page.waitForTimeout(1500)

// AC4 + AC5: send a message, verify routing and rendering
await page.fill('textarea', 'What is my research focus?')
await page.keyboard.press('Enter')
await page.waitForTimeout(2000)

assert('AC4: POST /api/chat was called', chatRequests.length >= 1, `called ${chatRequests.length} times`)
assert('AC4: request method is POST', chatRequests[0]?.method === 'POST', chatRequests[0]?.method)
assert('AC4: no requests to generativelanguage.googleapis.com', geminiBadRequests.length === 0, `${geminiBadRequests.length} bad requests`)

const assistantMsgs = await page.locator('.message.assistant').count()
assert('AC5: assistant message rendered', assistantMsgs >= 1, `found ${assistantMsgs}`)
const lastText = await page.locator('.message.assistant').last().textContent()
assert('AC5: response text matches mock', lastText?.includes('Hello from Wallenut runtime'), `got: "${lastText}"`)

// AC6: second message → capture button still appears
await page.fill('textarea', 'What are my fitness goals?')
await page.keyboard.press('Enter')
await page.waitForTimeout(2000)

assert('AC6: capture button visible after 2+ exchanges', await page.isVisible('.capture-btn'))

console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────\n`)
await browser.close()
process.exit(failed > 0 ? 1 : 0)
