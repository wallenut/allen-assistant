import { useState } from 'react'
import Markdown from 'react-markdown'

const today = new Date().toISOString().split('T')[0]

export default function ReviewPanel({ onClose }) {
  const [phase, setPhase] = useState('idle') // idle | loading | reviewing | applying | done | empty | error
  const [proposals, setProposals] = useState([])
  const [decisions, setDecisions] = useState({}) // index -> 'approve' | 'skip'
  const [error, setError] = useState('')

  async function startReview() {
    setPhase('loading')
    try {
      const res = await fetch('/api/promote/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: today }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Propose failed: ${res.status}`)
      }
      const { proposals: proposed } = await res.json()
      if (!proposed || !proposed.length) { setPhase('empty'); return }
      setProposals(proposed)
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

      const res = await fetch('/api/promote/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, date: today }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Apply failed: ${res.status}`)
      }

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
                <button className="review-action-btn" onClick={applyDecisions}>Apply approved</button>
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
              <p>Wiki updated. Un-promoted facts stay in <code>buffer/{today}.json</code> for next review.</p>
              <button className="review-action-btn" onClick={onClose}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
