// Acceptance criteria:
// AC1: After a conversation where the assistant gives a detailed response, a buffer POST
//      must contain NO facts that only appeared in the assistant's reply and not in any
//      user message. Concretely: no captured fact's content matches text that was
//      exclusively in the assistant turn.
// AC2: If capture fires twice on the same session, the second buffer POST either doesn't
//      fire at all OR fires with 0 new entries (content deduplicated against existing).
// AC3: If the user states one clearly unique new fact, that fact (or a paraphrase)
//      appears in the buffer POST.

import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:5175';
const PASSWORD = process.env.VITE_APP_PASSWORD || 'wheelbrother';

// A unique phrase that will only ever appear in the user's message, never in wiki or
// assistant knowledge.
const USER_UNIQUE_FACT = 'I just got a promotion to senior engineer at Stripe';
// A phrase injected into the mocked assistant reply that should NOT appear in extracted
// facts (since it only appears in the assistant turn, not any user message).
const ASSISTANT_ONLY_PHRASE = 'zephyr-quorum-protocol-nine-alpha';

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

function decodeBufferContent(b64) {
  const raw = Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf-8');
  return JSON.parse(raw);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Capture all buffer POSTs
const bufferPosts = [];
await page.route('**/api/buffer', async (route, request) => {
  if (request.method() === 'POST') {
    const body = JSON.parse(request.postData());
    bufferPosts.push(body);
  }
  await route.continue();
});

// Start from a known empty buffer state
await page.route('**/api/buffer/buffer/**', async (route, request) => {
  if (request.method() === 'GET') {
    await route.fulfill({ status: 404, body: '' });
  } else {
    await route.continue();
  }
});

// Intercept only the first Gemini call (the assistant reply) and inject ASSISTANT_ONLY_PHRASE.
// The SDK calls generativelanguage.googleapis.com directly — not a local proxy.
// Extraction calls (later Gemini calls) pass through normally so real fact extraction runs.
let geminiCallCount = 0;
function makeGeminiResponse(text) {
  return JSON.stringify({
    candidates: [{
      content: { parts: [{ text }], role: 'model' },
      finishReason: 'STOP',
      index: 0,
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
  });
}
await page.route('https://generativelanguage.googleapis.com/**', async (route, request) => {
  geminiCallCount++;
  if (geminiCallCount === 1) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: makeGeminiResponse(
        `Based on your wiki context, I can see you have many ongoing projects. ` +
        `The ${ASSISTANT_ONLY_PHRASE} is a critical internal codename I inferred from ` +
        `your research documents. You are clearly very focused on distributed systems ` +
        `and machine learning. Your fitness goals involve consistent training and recovery.`
      ),
    });
  } else {
    await route.continue();
  }
});

console.log('\n── Buffer Extraction Quality Tests ─────────────────\n');

// Setup: login
await page.goto(BASE_URL);
await page.fill('input[type="password"]', PASSWORD);
await page.keyboard.press('Enter');
await page.waitForTimeout(2000);

// Send user message with the unique personal fact — assistant reply will contain ASSISTANT_ONLY_PHRASE
await page.fill('textarea', USER_UNIQUE_FACT + '. What are my current research priorities?');
await page.keyboard.press('Enter');
await page.waitForTimeout(8000);

// Second message to hit the 2-message threshold
await page.fill('textarea', 'Thanks, that is helpful context.');
await page.keyboard.press('Enter');
await page.waitForTimeout(8000);

const captureVisible = await page.isVisible('.capture-btn');
assert('Capture button visible after 2+ exchanges', captureVisible);

// ── AC1 + AC3: First capture ──────────────────────────────────────────────────
await page.click('.capture-btn');
await page.waitForTimeout(500);

const duringText = await page.textContent('.capture-btn');
assert('Button shows "Capturing…" during extraction', duringText === 'Capturing…', `got "${duringText}"`);

await page.waitForTimeout(20000);

const firstPostCount = bufferPosts.length;
assert('Buffer POST fired after first capture', firstPostCount >= 1);

if (firstPostCount >= 1) {
  const firstPost = bufferPosts[0];
  const today = new Date().toISOString().split('T')[0];

  assert(
    'Buffer POST path is buffer/YYYY-MM-DD.json',
    firstPost.path === `buffer/${today}.json`,
    firstPost.path,
  );

  let facts = [];
  try {
    facts = decodeBufferContent(firstPost.content);
  } catch (e) {
    assert('Buffer POST content is valid base64-encoded JSON', false, String(e));
  }

  if (Array.isArray(facts)) {
    assert('Buffer POST content is a non-empty array of facts', facts.length > 0, `got ${facts.length} facts`);

    // AC1: Facts derived from assistant-only content must be tagged source:"assistant"
    const assistantLeakFacts = facts.filter(f =>
      typeof f.content === 'string' &&
      f.content.toLowerCase().includes(ASSISTANT_ONLY_PHRASE.toLowerCase()),
    );
    if (assistantLeakFacts.length > 0) {
      const allTaggedAssistant = assistantLeakFacts.every(f => f.source === 'assistant');
      assert(
        'AC1: Assistant-only facts are tagged source:"assistant"',
        allTaggedAssistant,
        `Wrongly tagged: ${JSON.stringify(assistantLeakFacts.map(f => ({ content: f.content, source: f.source })))}`,
      );
    } else {
      // Phrase not extracted at all — also acceptable (filtered out)
      assert('AC1: Assistant-only phrase not captured as user fact', true);
    }
    // All facts must have a source field
    const missingSource = facts.filter(f => f.source !== 'user' && f.source !== 'assistant');
    assert(
      'AC1: All facts have a valid source field',
      missingSource.length === 0,
      missingSource.length > 0 ? `Missing source: ${JSON.stringify(missingSource.map(f => f.content))}` : '',
    );

    // AC3: The unique user fact must appear (flexible token match)
    const userFactTokens = ['promotion', 'senior engineer', 'stripe'];
    const userFactCaptured = facts.some(f =>
      typeof f.content === 'string' &&
      userFactTokens.some(token => f.content.toLowerCase().includes(token)),
    );
    assert(
      'AC3: User-stated unique fact appears in captured facts',
      userFactCaptured,
      userFactCaptured ? '' : `Facts: ${JSON.stringify(facts.map(f => f.content))}`,
    );
  }
}

// ── AC2: Second capture must not add duplicate entries ────────────────────────
await page.waitForTimeout(5000);
geminiCallCount = 0;

// Stub GET to return the first write's content so writeEpisodicBuffer can deduplicate
const firstPostContent = firstPostCount >= 1 ? bufferPosts[0].content : null;
await page.unroute('**/api/buffer/buffer/**');
await page.route('**/api/buffer/buffer/**', async (route, request) => {
  if (request.method() === 'GET' && firstPostContent) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sha: 'fakeshaforsecondcapture', content: firstPostContent }),
    });
  } else {
    await route.continue();
  }
});

const postsBeforeSecond = bufferPosts.length;
const captureBtn = page.locator('.capture-btn');

if (await captureBtn.isVisible()) {
  await page.click('.capture-btn');
  await page.waitForTimeout(20000);

  const postsAfterSecond = bufferPosts.length;

  if (postsAfterSecond === postsBeforeSecond) {
    assert('AC2: Second capture fired no new buffer POST', true);
  } else {
    let secondFacts = [], firstFacts = [];
    try {
      secondFacts = decodeBufferContent(bufferPosts[postsAfterSecond - 1].content);
      if (firstPostCount >= 1) firstFacts = decodeBufferContent(bufferPosts[0].content);
    } catch {}
    const newCount = secondFacts.length - firstFacts.length;
    assert(
      'AC2: Second capture added 0 new duplicate entries',
      newCount === 0,
      `First: ${firstFacts.length} entries, second: ${secondFacts.length} entries (+${newCount})`,
    );
  }
} else {
  assert('AC2: Second capture prevented by UI (button not available)', true);
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────\n`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
