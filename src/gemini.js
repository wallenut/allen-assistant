import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(import.meta.env.VITE_GEMINI_API_KEY)

const FALLBACK_PROMPT = `You are Wallenut, Allen Wang's personal AI assistant and second brain.
Be concise, direct, and helpful. You know Allen well.`

// The router pre-selects the door(s) a query is about; this tool lets the model
// pull any *other* domain's note on demand when it realizes it needs more — the
// "depth on demand" half of progressive disclosure.
function readWikiTool(domains) {
  if (!domains || !domains.length) return undefined
  return [{
    functionDeclarations: [{
      name: 'read_wiki',
      description: "Load the full current-state note for one of Allen's domains when you " +
        "need detail that isn't already in context. Returns that domain's markdown.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          domain: {
            type: SchemaType.STRING,
            enum: domains,
            description: 'Which domain note to load.',
          },
        },
        required: ['domain'],
      },
    }],
  }]
}

export async function sendMessage(history, text, systemPrompt, wiki) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: systemPrompt || FALLBACK_PROMPT,
    tools: readWikiTool(wiki?.domains),
  })

  const chat = model.startChat({
    history: history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text }],
    })),
  })

  let result = await chat.sendMessage(text)

  // Resolve read_wiki calls until the model produces a text answer (bounded).
  for (let i = 0; i < 4; i++) {
    const calls = result.response.functionCalls?.() || []
    if (!calls.length) break
    const parts = calls.map(c => ({
      functionResponse: {
        name: c.name,
        response: { content: wiki?.readDomain(c.args?.domain) ?? `No domain named "${c.args?.domain}".` },
      },
    }))
    result = await chat.sendMessage(parts)
  }

  // If the model is still asking for tools after the loop bound, text() is empty —
  // return a graceful message rather than a blank reply.
  return result.response.text() || "I couldn't finish pulling that together — mind rephrasing?"
}
