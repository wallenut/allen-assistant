// Acceptance criteria (regression for silent capture failure seen on Railway prod):
// 1. When a capture write FAILS, the failure is surfaced in the UI (not swallowed).
// 2. A failed auto-capture (on visibilitychange) does NOT latch the session as captured.
// 3. After a failed capture, clicking Capture RETRIES (fires another buffer write).
//
// Gemini is mocked (no real API key needed); /api/buffer POST is forced to 500 to
// simulate the prod write failure.

import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:5175';
const PASSWORD = process.env.VITE_APP_PASSWORD || 'wheelbrother';

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// P4: chat goes through the runtime (/api/chat SSE). Mock it so the exchange
// completes without a running runtime or API key.
await page.route('**/api/chat', route =>
  route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: 'data: {"type":"text","text":"test response"}\n\ndata: {"type":"done"}\n\n',
  })
);

// Mock Gemini for fact extraction (the only remaining Gemini call after P4).
const GEMINI_TEXT = '[{"type":"fact","content":"test fact","source":"user"}]';
await page.route('**generativelanguage.googleapis.com**', route =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: GEMINI_TEXT }] }, finishReason: 'STOP', index: 0 }],
    }),
  })
);

// Mock buffer: GET -> 404 (no existing file); POST -> 500 (simulate prod write failure).
const bufferPosts = [];
await page.route('**/api/buffer**', (route, request) => {
  if (request.method() === 'POST') {
    bufferPosts.push(JSON.parse(request.postData()));
    return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"simulated prod failure"}' });
  }
  return route.fulfill({ status: 404, body: '' });
});

console.log('\n── Capture Error-Surfacing Tests ──────────────────\n');

await page.goto(BASE_URL);
await page.fill('input[type="password"]', PASSWORD);
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);

// One exchange -> 2 real messages (user + assistant), enough to enable capture.
await page.fill('textarea', 'hello');
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);

assert('Capture button visible after an exchange', await page.isVisible('.capture-btn'));

// Trigger auto-capture the way prod did: tab/app goes to background.
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(2500);
assert('Auto-capture attempted a buffer write', bufferPosts.length >= 1, `posts=${bufferPosts.length}`);

// Restore visibility and inspect the button.
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(500);

const btnText = (await page.textContent('.capture-btn'))?.trim() || '';
const isDisabled = await page.getAttribute('.capture-btn', 'disabled');
// AC1: failure surfaced (button is not silently back to plain "Capture" with no error)
assert('Failed capture is surfaced in the button', /fail|retry|error/i.test(btnText), `button="${btnText}"`);
// AC2: not stuck disabled
assert('Capture button is not stuck disabled after failure', isDisabled === null);

// AC3: manual click retries (fires another write attempt).
const before = bufferPosts.length;
await page.click('.capture-btn');
await page.waitForTimeout(2500);
assert('Clicking Capture after a failure retries the write', bufferPosts.length > before, `before=${before} after=${bufferPosts.length}`);

// Manual-path failure must also be surfaced (not silently reset to "Capture").
const btnText2 = (await page.textContent('.capture-btn'))?.trim() || '';
assert('Manual capture failure is also surfaced', /fail|retry|error/i.test(btnText2), `button="${btnText2}"`);

console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────\n`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
