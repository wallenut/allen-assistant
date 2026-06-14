import { useState, useRef, useEffect } from 'react'
import Markdown from 'react-markdown'
import './App.css'
import { sendMessage } from './gemini.js'
import { initWikiContext } from './wiki.js'
import { captureToServer } from './buffer.js'
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
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  const wikiRef = useRef(null)
  const sessionsRef = useRef(sessions)
  const activeIdRef = useRef(activeId)
  const recognitionRef = useRef(null)
  const transcriptRef = useRef('')
  const finalTranscriptRef = useRef('')
  const manualStopRef = useRef(false)
  const voiceInputRef = useRef(false)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)
  const capturedRef = useRef(false)
  const captureInFlightRef = useRef(false)

  const [captureStatus, setCaptureStatus] = useState(null)

  const activeSession = sessions.find(s => s.id === activeId) || sessions[0]
  const messages = activeSession.messages

  useEffect(() => {
    initWikiContext().then(ctx => { wikiRef.current = ctx })
    window.speechSynthesis.getVoices()
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices()

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') captureSession()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    capturedRef.current = false
    captureInFlightRef.current = false
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

  async function captureSession() {
    // Already captured this session, or a capture is mid-flight — don't double-write.
    if (capturedRef.current || captureInFlightRef.current) return
    const session = sessionsRef.current.find(s => s.id === activeIdRef.current)
    const realMessages = (session?.messages || []).filter(m => m.id !== 0)
    if (realMessages.length < 2) return
    captureInFlightRef.current = true
    setCaptureStatus('capturing')
    try {
      const { count } = await captureToServer(realMessages)
      capturedRef.current = true // latch only on success, so failures stay retryable
      setCaptureStatus(count)
      setTimeout(() => setCaptureStatus(null), 3000)
    } catch (err) {
      console.error('captureSession failed:', err)
      setCaptureStatus('error') // surface the failure instead of swallowing it
    } finally {
      captureInFlightRef.current = false
    }
  }

  function speak(text) {
    window.speechSynthesis.cancel()
    const clean = stripMarkdown(text)
    if (!clean) return

    // Chrome silently stops a single utterance after ~15s. Split into sentence-sized
    // chunks and queue them so each plays fully and auto-advances. Long sentences are
    // further split on commas/length so no single chunk trips the limit.
    const sentences = clean.match(/[^.!?\n]+[.!?]*(?:\s+|$)/g) || [clean]
    const chunks = []
    for (const s of sentences) {
      const t = s.trim()
      if (!t) continue
      if (t.length <= 200) { chunks.push(t); continue }
      let buf = ''
      for (const part of t.split(/(?<=,)\s+/)) {
        if ((buf + ' ' + part).trim().length > 200) { if (buf) chunks.push(buf.trim()); buf = part }
        else buf = (buf + ' ' + part).trim()
      }
      if (buf) chunks.push(buf.trim())
    }
    if (chunks.length === 0) return

    const voice = getJarvisVoice()

    // Chrome also pauses the whole queue at ~15s; nudging resume() keeps it alive.
    const keepAlive = setInterval(() => {
      if (window.speechSynthesis.speaking) window.speechSynthesis.resume()
      else clearInterval(keepAlive)
    }, 5000)

    chunks.forEach((chunk, i) => {
      const u = new SpeechSynthesisUtterance(chunk)
      if (voice) u.voice = voice
      u.pitch = 0.85
      u.rate = 1.05
      u.volume = 1
      if (i === 0) u.onstart = () => setSpeaking(true)
      if (i === chunks.length - 1) {
        u.onend = () => { setSpeaking(false); clearInterval(keepAlive) }
      }
      u.onerror = () => { setSpeaking(false); clearInterval(keepAlive) }
      window.speechSynthesis.speak(u)
    })
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
      const wiki = wikiRef.current
      const systemPrompt = wiki ? wiki.buildPrompt(text) : null
      const responseText = await sendMessage(history, text, systemPrompt, wiki)
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
      manualStopRef.current = true
      recognitionRef.current?.stop()
      const transcript = transcriptRef.current
      transcriptRef.current = ''
      finalTranscriptRef.current = ''
      setListening(false)
      if (transcript) doSend(transcript, true)
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) { alert('Speech recognition is not supported in this browser.'); return }

    manualStopRef.current = false
    finalTranscriptRef.current = ''
    transcriptRef.current = ''

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.onstart = () => setListening(true)
    // Accumulate FINAL results into a persistent buffer so they survive auto-restarts;
    // show interim on top. (Rebuilding from e.results would reset on each restart.)
    recognition.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalTranscriptRef.current += r[0].transcript + ' '
        else interim += r[0].transcript
      }
      transcriptRef.current = (finalTranscriptRef.current + interim).trim()
    }
    recognition.onerror = (ev) => {
      // Permission problems are terminal; silence/no-speech is not — let onend restart.
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        manualStopRef.current = true
        setListening(false)
      }
    }
    // Browser ends the session on silence/timeout. If the user hasn't tapped stop,
    // restart so long, paused brain-dumps keep going and nothing is stranded.
    recognition.onend = () => {
      if (!manualStopRef.current) {
        try { recognition.start(); return } catch { /* fall through */ }
      }
      setListening(false)
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

        <button className="review-buffer-btn" onClick={() => { setSidebarOpen(false); setReviewOpen(true) }}>
          Review buffer
        </button>

        {archivedSessions.length > 0 && (
          <>
            <div className="sidebar-section-label">Archived</div>
            <div className="session-list">
              {archivedSessions.map(s => (
                <div key={s.id} className={`session-item archived${s.id === activeId ? ' active' : ''}`}>
                  <button className="session-item-main" onClick={() => switchSession(s.id)}>
                    <span className="session-name">{s.name || 'Untitled'}</span>
                    <span className="session-date">{new Date(s.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
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
          <>
              <button className="new-chat-btn" onClick={createSession}>
                New Chat
              </button>
              {messages.filter(m => m.id !== 0).length > 0 && (
                <button
                  className={`capture-btn${captureStatus === 'error' ? ' capture-btn-error' : ''}`}
                  onClick={captureSession}
                  disabled={captureStatus === 'capturing'}
                  title={captureStatus === 'error'
                    ? 'Capture failed to save — click to retry'
                    : 'Extract and capture facts from this session'}
                >
                  {captureStatus === 'capturing'
                    ? 'Capturing…'
                    : captureStatus === 'error'
                    ? 'Capture failed — retry'
                    : typeof captureStatus === 'number'
                    ? `Captured ${captureStatus} facts`
                    : 'Capture'}
                </button>
              )}
            </>
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
