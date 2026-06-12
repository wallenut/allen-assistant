async function exaSearch(query, key) {
  const r = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, type: 'auto', numResults: 5, contents: { text: { maxCharacters: 1000 } } }),
  });
  if (!r.ok) throw new Error(`Exa ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return (data.results || []).map((x) => ({ title: x.title, url: x.url, text: x.text }));
}

export const webSearch = {
  name: 'web_search',
  description:
    "Search the live web for current or external information not in Allen's wiki — news, facts, prices, docs, anything time-sensitive or outside his notes. Returns grounded results with source URLs.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
    },
    required: ['query'],
  },
  async run({ query }) {
    const key = process.env.EXA_API_KEY;
    if (!key) return 'Web search unavailable: set EXA_API_KEY';
    try {
      const results = await exaSearch(query, key);
      if (!results.length) return 'No results found.';
      return results.map((r) => `- ${r.title}: ${r.url}\n  ${r.text}`).join('\n\n');
    } catch (err) {
      return `Web search failed: ${err.message}`;
    }
  },
};
