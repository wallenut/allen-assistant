import { useState, useRef, useEffect } from 'react'
import Markdown from 'react-markdown'
import './App.css'
import { sendMessage } from './gemini.js'
import { loadWikiContext } from './wiki.js'
import { writeBuffer, extractFacts, writeEpisodicBuffer } from './buffer.js'
import ReviewPanel from './ReviewPanel.jsx'

const GREETING = { id: 0, role: 'assistant', text: "Hey Allen. What's on your mind?", time: '' }

const AUTH_KEY = 'wallenut_auth'

function isAuthed() {
  return localStorage.getItem(AUTH_KEY) === 'true'
}

function Gate({ onUnlock }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)

  function attempt() {
    if (value === import.meta.env.VITE_APP_PASSWORD) {
      localStorage.setItem(AUTH_KEY, 'true')
      onUnlock()
    } else {
      setError(true)
      setValue('')
    }
  }

  return (
    <div className="gate">
      <span className="wordmark" style={{ marginBottom: 24 }}>Wallenut</span>
      <input
        className="gate-input"
        type="password"
        placeholder="Password"
        value={value}
        autoFocus
        onChange={e => { setValue(e.target.value); setError(false) }}
        onKeyDown={e => e.key === 'Enter' && attempt()}
      />
      {error && <span className="gate-error">Wrong password</span>}
      <button className="gate-btn" onClick={attempt}>Unlock</button>
    </div>
  )
}

// ── Session storage ──────────────────────────────────────────────────────────

const SESSIONS_KEY = 'wallenut_sessions'
const ACTIVE_KEY = 'wallenut_active'

function newSession() {
  return { id: Date.now().toString(), name: null, messages: [GREETING], createdAt: Date.now(), archived: false }
}

function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (raw) {
      const sessions = JSON.parse(raw)
      if (sessions.length) return sessions
    }
  } catch {}
  // Migrate from old single-session storage
  try {
    const old = localStorage.getItem('wallenut_messages')
    if (old) {
      const messages = JSON.parse(old)
      localStorage.removeItem('wallenut_messages')
      return [{ id: Date.now().toString(), name: null, messages, createdAt: Date.now(), archived: false }]
    }
  } catch {}
  return [newSession()]
}

function saveSessions(sessions) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)) } catch {}
}

function loadActiveId(sessions) {
  try {
    const saved = localStorage.getItem(ACTIVE_KEY)
    if (saved && sessions.find(s => s.id === saved)) return saved
  } catch {}
  return sessions[0].id
}

function saveActiveId(id) {
  try { localStorage.setItem(ACTIVE_KEY, id) } catch {}
}

// ── Voice helpers ────────────────────────────────────────────────────────────

const VOICE_PRIORITY = ['Google UK English Male', 'Daniel', 'Arthur', 'Google UK English']

function getJarvisVoice() {
  const voices = window.speechSynthesis.getVoices()
  for (const name of VOICE_PRIORITY) {
    const match = voices.find(v => v.name === name)
    if (match) return match
  }
  return voices.find(v => v.lang.startsWith('en-GB')) || voices[0] || null
}

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/\n+/g, ' ')
    .trim()
}

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const [authed, setAuthed] = useState(isAuthed)
  if (!authed) return <Gate onUnlock={() => setAuthed(true)} />
  return <Chat />
}

function Chat() {
  const [sessions, setSessions] = useState(loadSessions)
  const [activeId, setActiveId] = useState(() => loadActiveId(sessions))
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [resavingId, setResavingId] = useState(null)
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  const systemPromptRef = useRef(null)
  const sessionsRef = useRef(sessions)
  const activeIdRef = useRef(activeId)
  const recognitionRef = useRef(null)
  const transcriptRef = useRef('')
  const voiceInputRef = useRef(false)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)
  const capturedRef = useRef(false)

  const [captureStatus, setCaptureStatus] = useState(null)

  const activeSession = sessions.find(s => s.id === activeId) || sessions[0]
  const messages = activeSession.messages

  useEffect(() => {
    loadWikiContext().then(p => { systemPromptRef.current = p })
    window.speechSynthesis.getVoices()
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices()

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        const session = sessionsRef.current.find(s => s.id === activeIdRef.current)
        const realMessages = (session?.messages || []).filter(m => m.id !== 0)
        if (realMessages.length >= 2 && !capturedRef.current) {
          capturedRef.current = true
          extractFacts(realMessages).then(facts => writeEpisodicBuffer(facts)).catch(() => {})
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    capturedRef.current = false
    setCaptureStatus(null)
  }, [activeId])

  function updateSessions(updated) {
    sessionsRef.current = updated
    setSessions(updated)
    saveSessions(updated)
  }

  function appendMessage(msg) {
    const updated = sessionsRef.current.map(s =>
      s.id === activeIdRef.current ? { ...s, messages: [...s.messages, msg] } : s
    )
    updateSessions(updated)
  }

  function switchSession(id) {
    window.speechSynthesis.cancel()
    activeIdRef.current = id
    setActiveId(id)
    saveActiveId(id)
    setSidebarOpen(false)
    setInput('')
  }

  function createSession() {
    const s = newSession()
    const updated = [s, ...sessionsRef.current]
    updateSessions(updated)
    switchSession(s.id)
  }

  async function saveChat() {
    if (saving) return
    setSaving(true)
    try {
      const session = sessionsRef.current.find(s => s.id === activeIdRef.current)
      const excerpt = session.messages
        .filter(m => m.id !== 0)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n')

      const summary = await sendMessage([], excerpt,
        'Summarize this conversation in 2-3 sentences capturing the key topics, decisions, and emotional context. Be specific — name actual things discussed. Reply with ONLY the summary.'
      )

      await writeBuffer(summary.trim(), session.name)

      const updated = sessionsRef.current.map(s =>
        s.id === activeIdRef.current ? { ...s, archived: true } : s
      )
      updateSessions(updated)
      createSession()
    } catch (err) {
      console.error('Save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  async function captureSession() {
    const session = sessionsRef.current.find(s => s.id === activeIdRef.current)
    const realMessages = (session?.messages || []).filter(m => m.id !== 0)
    if (realMessages.length < 2 || capturedRef.current) return
    capturedRef.current = true
    setCaptureStatus('capturing')
    try {
      const facts = await extractFacts(realMessages)
      await writeEpisodicBuffer(facts)
      setCaptureStatus(facts.length)
      setTimeout(() => setCaptureStatus(null), 3000)
    } catch (err) {
      console.error('captureSession failed:', err)
      capturedRef.current = false
      setCaptureStatus(null)
    }
  }

  async function resaveSession(session) {
    if (resavingId) return
    setResavingId(session.id)
    try {
      const excerpt = session.messages
        .filter(m => m.id !== 0)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n')
      const summary = await sendMessage([], excerpt,
        'Summarize this conversation in 2-3 sentences capturing the key topics, decisions, and emotional context. Be specific — name actual things discussed. Reply with ONLY the summary.'
      )
      await writeBuffer(summary.trim(), session.name)
    } catch (err) {
      console.error('Resave failed:', err)
    } finally {
      setResavingId(null)
    }
  }

  function speak(text) {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(stripMarkdown(text))
    const voice = getJarvisVoice()
    if (voice) utterance.voice = voice
    utterance.pitch = 0.85
    utterance.rate = 1.05
    utterance.volume = 1
    utterance.onstart = () => setSpeaking(true)
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
    window.speechSynthesis.speak(utterance)
  }

  function stopSpeaking() {
    window.speechSynthesis.cancel()
    setSpeaking(false)
  }

  async function nameSession(sessionId, messages) {
    const excerpt = messages
      .filter(m => m.id !== 0)
      .slice(0, 4)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .join('\n')
    try {
      const title = await sendMessage([], excerpt,
        'You generate short chat titles. Given a conversation excerpt, reply with ONLY a 3-5 word title. No punctuation, no quotes, no explanation.'
      )
      const name = title.trim().replace(/["""'']/g, '').slice(0, 40)
      const updated = sessionsRef.current.map(s => s.id === sessionId ? { ...s, name } : s)
      updateSessions(updated)
    } catch {}
  }

  async function doSend(text, fromVoice = false) {
    if (!text || loading) return
    voiceInputRef.current = fromVoice
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const userMsg = { id: Date.now(), role: 'user', text, time: now }
    appendMessage(userMsg)
    setLoading(true)

    try {
      const currentMessages = sessionsRef.current.find(s => s.id === activeIdRef.current)?.messages || []
      const history = currentMessages.filter(m => m.id !== 0 && m.id !== userMsg.id)
      const responseText = await sendMessage(history, text, systemPromptRef.current)
      const replyTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      appendMessage({ id: Date.now() + 1, role: 'assistant', text: responseText, time: replyTime })
      if (voiceInputRef.current) speak(responseText)

      // Auto-name after first complete exchange
      const session = sessionsRef.current.find(s => s.id === activeIdRef.current)
      if (session && !session.name) {
        const allMessages = sessionsRef.current.find(s => s.id === activeIdRef.current)?.messages || []
        const realMessages = allMessages.filter(m => m.id !== 0)
        if (realMessages.length >= 2) nameSession(activeIdRef.current, allMessages)
      }
    } catch (err) {
      console.error('Gemini error:', err)
      appendMessage({ id: Date.now() + 1, role: 'assistant', text: 'Something went wrong. Try again.', time: '' })
    } finally {
      setLoading(false)
    }
  }

  function send() {
    const text = input.trim()
    if (!text) return
    setInput('')
    textareaRef.current.style.height = 'auto'
    doSend(text, false)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function handleInput(e) {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = e.target.scrollHeight + 'px'
  }

  function toggleMic() {
    if (speaking) { stopSpeaking(); return }

    if (listening) {
      const transcript = transcriptRef.current
      transcriptRef.current = ''
      recognitionRef.current?.stop()
      if (transcript) doSend(transcript, true)
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) { alert('Speech recognition is not supported in this browser.'); return }

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.onstart = () => setListening(true)
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognition.onresult = (e) => {
      let text = ''
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
      transcriptRef.current = text.trim()
    }

    recognitionRef.current = recognition
    recognition.start()
  }

  const micLabel = speaking ? 'Stop speaking' : listening ? 'Stop listening' : 'Voice input'
  const micClass = `mic-btn${listening ? ' listening' : ''}${speaking ? ' speaking' : ''}`
  const activeSessions = sessions.filter(s => !s.archived)
  const archivedSessions = sessions.filter(s => s.archived)

  return (
    <div className="app">
      {reviewOpen && <ReviewPanel onClose={() => setReviewOpen(false)} />}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-header">
          <span className="sidebar-title">Chats</span>
          <button className="sidebar-new" onClick={createSession}>+ New</button>
        </div>

        <div className="session-list">
          {activeSessions.map(s => (
            <button
              key={s.id}
              className={`session-item${s.id === activeId ? ' active' : ''}`}
              onClick={() => switchSession(s.id)}
            >
              <span className="session-name">{s.name || 'New conversation'}</span>
              <span className="session-date">{new Date(s.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
            </button>
          ))}
        </div>

        {archivedSessions.length > 0 && (
          <>
            <button className="review-buffer-btn" onClick={() => { setSidebarOpen(false); setReviewOpen(true) }}>
          Review buffer
        </button>

        <div className="sidebar-section-label">Archived</div>
            <div className="session-list">
              {archivedSessions.map(s => (
                <div key={s.id} className={`session-item archived${s.id === activeId ? ' active' : ''}`}>
                  <button className="session-item-main" onClick={() => switchSession(s.id)}>
                    <span className="session-name">{s.name || 'Untitled'}</span>
                    <span className="session-date">{new Date(s.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                  </button>
                  <button
                    className="resave-btn"
                    onClick={() => resaveSession(s)}
                    disabled={resavingId === s.id}
                    title="Re-save to buffer"
                  >
                    {resavingId === s.id ? '…' : '↑'}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      <div className="main">
        <header className="header">
          <button className="menu-btn" onClick={() => setSidebarOpen(o => !o)} aria-label="Toggle sidebar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <span className="wordmark">Wallenut</span>
          {messages.filter(m => m.id !== 0).length > 0 && (
            <>
              <button className="save-btn" onClick={saveChat} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                className="capture-btn"
                onClick={captureSession}
                disabled={captureStatus === 'capturing'}
                title="Extract and capture facts from this session"
              >
                {captureStatus === 'capturing'
                  ? 'Capturing…'
                  : typeof captureStatus === 'number'
                  ? `Captured ${captureStatus} facts`
                  : 'Capture'}
              </button>
            </>
          )}
        </header>

        <div className="messages">
          {messages.map(msg => (
            <div key={msg.id} className={`message ${msg.role}`}>
              <div className="bubble"><Markdown>{msg.text}</Markdown></div>
              {msg.time && <span className="message-meta">{msg.time}</span>}
            </div>
          ))}
          {loading && (
            <div className="message assistant">
              <div className="bubble typing"><span /><span /><span /></div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="input-bar">
          <button className={micClass} onClick={toggleMic} aria-label={micLabel}>
            <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="9" y1="22" x2="15" y2="22" />
            </svg>
          </button>
          <div className="input-wrap">
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder={listening ? 'Listening…' : 'Message Wallenut…'}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              disabled={loading}
            />
            <button className="send-btn" onClick={send} disabled={!input.trim() || loading} aria-label="Send">
              <svg viewBox="0 0 16 16"><path d="M1 8L15 1l-4 7 4 7L1 8z"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
