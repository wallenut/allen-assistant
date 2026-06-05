import { useState } from 'react'
import Markdown from 'react-markdown'
import { sendMessage } from './gemini.js'

const today = new Date().toISOString().split('T')[0]

async function readTodayBuffer() {
  const res = await fetch(`/api/buffer/buffer/${today}.md`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Failed to read buffer')
  const data = await res.json()
  return atob(data.content.replace(/\n/g, ''))
}

async function readWikiFile(path) {
  const res = await fetch(`/api/wiki/${path}`)
  if (!res.ok) return ''
  return res.text()
}

async function writeWikiFile(path, content) {
  const res = await fetch('/api/wiki-write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  })
  if (!res.ok) throw new Error('Write failed')
}

async function moveBuffer() {
  const res = await fetch('/api/buffer-move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: today }),
  })
  if (!res.ok) throw new Error('Move failed')
}

const WIKI_FILES = [
  'allen_synthesis.md',
  'research/current_state.md',
  'fitness/current_state.md',
  'life/current_state.md',
  'ops/tasks.md',
]

export default function ReviewPanel({ onClose }) {
  const [phase, setPhase] = useState('idle') // idle | loading | reviewing | applying | done | empty | error
  const [proposals, setProposals] = useState([])
  const [decisions, setDecisions] = useState({}) // index -> 'approve' | 'skip'
  const [error, setError] = useState('')

  async function startReview() {
    setPhase('loading')
    try {
      const buffer = await readTodayBuffer()
      if (!buffer) { setPhase('empty'); return }

      const wikiContents = await Promise.all(WIKI_FILES.map(f => readWikiFile(f).then(c => `## ${f}\n\n${c}`)))
      const wikiSummary = wikiContents.join('\n\n---\n\n')

      const prompt = `You are reviewing today's conversation buffer to identify what should be added to Allen's wiki.

BUFFER (today's saved conversations):
${buffer}

CURRENT WIKI STATE:
${wikiSummary}

Your task:
1. Identify which buffer entries contain NEW, meaningful information not already in the wiki (ignore throwaway chats)
2. For each meaningful finding, propose a specific addition to a specific wiki file

Respond with a JSON array only, no other text. Each item:
{
  "file": "<one of: allen_synthesis.md, research/current_state.md, fitness/current_state.md, life/current_state.md, ops/tasks.md>",
  "rationale": "<one sentence: why this matters>",
  "addition": "<exact markdown text to append to the file>"
}

If nothing meaningful found, return an empty array [].`

      const raw = await sendMessage([], prompt, 'You are a precise JSON generator. Output only valid JSON, nothing else.')
      const json = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const parsed = JSON.parse(json)

      if (!parsed.length) { setPhase('empty'); return }
      setProposals(parsed)
      setPhase('reviewing')
    } catch (err) {
      console.error(err)
      setError(err.message)
      setPhase('error')
    }
  }

  async function applyDecisions() {
    setPhase('applying')
    try {
      const approved = proposals.filter((_, i) => decisions[i] === 'approve')

      for (const p of approved) {
        const current = await readWikiFile(p.file)
        const updated = current.trimEnd() + '\n\n' + p.addition.trim() + '\n'
        await writeWikiFile(p.file, updated)
      }

      await moveBuffer()
      setPhase('done')
    } catch (err) {
      setError(err.message)
      setPhase('error')
    }
  }

  function decide(i, val) {
    setDecisions(prev => ({ ...prev, [i]: prev[i] === val ? undefined : val }))
  }

  const allDecided = proposals.length > 0 && proposals.every((_, i) => decisions[i])

  return (
    <div className="review-overlay">
      <div className="review-panel">
        <div className="review-header">
          <span className="review-title">Buffer Review — {today}</span>
          <button className="review-close" onClick={onClose}>✕</button>
        </div>

        <div className="review-body">
          {phase === 'idle' && (
            <div className="review-start">
              <p>Review today's saved conversations and propose wiki updates.</p>
              <button className="review-action-btn" onClick={startReview}>Start Review</button>
            </div>
          )}

          {phase === 'loading' && (
            <div className="review-loading">
              <div className="bubble typing"><span /><span /><span /></div>
              <span>Analysing buffer…</span>
            </div>
          )}

          {phase === 'empty' && (
            <div className="review-start">
              <p>No buffer entries found for today, or nothing meaningful to add to the wiki.</p>
            </div>
          )}

          {phase === 'error' && (
            <div className="review-start">
              <p style={{ color: '#e05555' }}>Error: {error}</p>
            </div>
          )}

          {phase === 'reviewing' && (
            <>
              <div className="proposal-list">
                {proposals.map((p, i) => (
                  <div key={i} className={`proposal${decisions[i] ? ' decided' : ''}`}>
                    <div className="proposal-file">{p.file}</div>
                    <div className="proposal-rationale">{p.rationale}</div>
                    <div className="proposal-addition"><Markdown>{p.addition}</Markdown></div>
                    <div className="proposal-actions">
                      <button
                        className={`proposal-btn approve${decisions[i] === 'approve' ? ' selected' : ''}`}
                        onClick={() => decide(i, 'approve')}
                      >Add</button>
                      <button
                        className={`proposal-btn skip${decisions[i] === 'skip' ? ' selected' : ''}`}
                        onClick={() => decide(i, 'skip')}
                      >Skip</button>
                    </div>
                  </div>
                ))}
              </div>
              {allDecided && (
                <button className="review-action-btn" onClick={applyDecisions}>Apply & Archive</button>
              )}
            </>
          )}

          {phase === 'applying' && (
            <div className="review-loading">
              <div className="bubble typing"><span /><span /><span /></div>
              <span>Writing to wiki…</span>
            </div>
          )}

          {phase === 'done' && (
            <div className="review-start">
              <p>Wiki updated. Buffer archived to <code>buffer/reviewed/{today}.md</code>.</p>
              <button className="review-action-btn" onClick={onClose}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
