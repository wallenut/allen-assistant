import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(import.meta.env.VITE_GEMINI_API_KEY)

const FALLBACK_PROMPT = `You are Wallenut, Allen Wang's personal AI assistant and second brain.
Be concise, direct, and helpful. You know Allen well.`

export async function sendMessage(history, text, systemPrompt) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: systemPrompt || FALLBACK_PROMPT,
  })

  const chat = model.startChat({
    history: history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text }],
    })),
  })

  const result = await chat.sendMessage(text)
  return result.response.text()
}
