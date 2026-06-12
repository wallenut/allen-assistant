// Unit tests for the web_search tool — no real API calls.
import assert from 'node:assert';
import { webSearch } from './tools/web_search.js';

async function run() {
  // Test 1: valid Exa response → result contains title and url.
  {
    const saved = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = 'test-key';
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        results: [{ title: 'Test Title', url: 'https://example.com', text: 'Some snippet.' }],
      }),
    });
    const result = await webSearch.run({ query: 'test query' });
    assert.ok(result.includes('Test Title'), `Expected title in result, got: ${result}`);
    assert.ok(result.includes('https://example.com'), `Expected url in result, got: ${result}`);
    process.env.EXA_API_KEY = saved;
  }

  // Test 2: empty results → 'No results found.'
  {
    const saved = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = 'test-key';
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ results: [] }),
    });
    const result = await webSearch.run({ query: 'empty query' });
    assert.strictEqual(result, 'No results found.', `Expected 'No results found.', got: ${result}`);
    process.env.EXA_API_KEY = saved;
  }

  // Test 3: fetch throws → result starts with 'Web search failed:'
  {
    const saved = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = 'test-key';
    globalThis.fetch = async () => { throw new Error('network error'); };
    const result = await webSearch.run({ query: 'failing query' });
    assert.ok(result.startsWith('Web search failed:'), `Expected failure message, got: ${result}`);
    process.env.EXA_API_KEY = saved;
  }

  // Test 4: no EXA_API_KEY → 'Web search unavailable: set EXA_API_KEY'
  {
    const saved = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    const result = await webSearch.run({ query: 'no key query' });
    assert.strictEqual(result, 'Web search unavailable: set EXA_API_KEY', `Expected unavailable message, got: ${result}`);
    if (saved !== undefined) process.env.EXA_API_KEY = saved;
  }

  console.log('PASS — web_search tool');
}

run().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
