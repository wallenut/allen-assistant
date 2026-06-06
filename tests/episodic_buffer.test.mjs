// Acceptance criteria:
// 1. Capture button is hidden before any messages
// 2. Capture button appears after 2+ message exchanges
// 3. Clicking Capture writes to buffer/YYYY-MM-DD.json via /api/buffer POST
// 4. Button shows "Capturing…" during extraction, then confirmation, then resets
// 5. Double-clicking does not produce a second buffer write

import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:5175';
const PASSWORD = process.env.VITE_APP_PASSWORD || 'wheelbrother';

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const bufferWrites = [];
await page.route('**/api/buffer', (route, request) => {
  if (request.method() === 'POST') bufferWrites.push(JSON.parse(request.postData()));
  route.continue();
});

console.log('\n── Episodic Buffer Tests ──────────────────────────\n');

// Setup: login
await page.goto(BASE_URL);
await page.fill('input[type="password"]', PASSWORD);
await page.keyboard.press('Enter');
await page.waitForTimeout(2000);

// AC1: Capture button hidden before messages
const hiddenBefore = !(await page.isVisible('.capture-btn'));
assert('Capture button hidden before messages', hiddenBefore);

// Send two exchanges
await page.fill('textarea', 'What is my current research focus?');
await page.keyboard.press('Enter');
await page.waitForTimeout(8000);
await page.fill('textarea', 'What are my fitness goals?');
await page.keyboard.press('Enter');
await page.waitForTimeout(8000);

// AC2: Capture button visible after 2+ exchanges
const visibleAfter = await page.isVisible('.capture-btn');
assert('Capture button visible after 2+ exchanges', visibleAfter);

// AC3 + AC4: Click capture, observe states and buffer write
await page.click('.capture-btn');
await page.waitForTimeout(500);
const duringText = await page.textContent('.capture-btn');
assert('Button shows "Capturing…" during extraction', duringText === 'Capturing…', `got "${duringText}"`);

await page.waitForTimeout(15000);
assert('Buffer POST fired to /api/buffer', bufferWrites.length >= 1);
if (bufferWrites.length > 0) {
  const today = new Date().toISOString().split('T')[0];
  assert('Buffer write path is buffer/YYYY-MM-DD.json', bufferWrites[0].path === `buffer/${today}.json`, bufferWrites[0].path);
  assert('Buffer write message is episodic: YYYY-MM-DD', bufferWrites[0].message === `episodic: ${today}`, bufferWrites[0].message);
}

// AC5: Double-click does not produce second write
const writesBefore = bufferWrites.length;
await page.click('.capture-btn');
await page.waitForTimeout(3000);
assert('Double-click does not produce second buffer write', bufferWrites.length === writesBefore);

console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────\n`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
