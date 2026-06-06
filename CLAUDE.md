# Allen Assistant — CLAUDE.md

## What this is
Wallenut — a minimal personal AI assistant web app (React/Vite) for Allen:
loads the **allen-wiki** GitHub repo as its knowledge base, supports voice
in/out, calls the Gemini API.

Doubles as a sandbox — the memory and agentic patterns proven here feed
EmerGPT (Sam's agentic OS for medical practices; Allen's consulting track).
Current direction and active decisions live in the wiki, not here: read
`projects/emerGPT/current_state.md` first. Keep this file to durable
rules/conventions; volatile state belongs in the wiki. The build order below
is the original scaffold spec (complete).

## Four rules (Karpathy)

### 1. Think before coding
- State your assumptions explicitly before writing any code
- If a requirement is ambiguous, present interpretations and ask
- Never guess silently — a wrong assumption compounds fast

### 2. Keep it simple
- Write the minimum code that solves the stated problem
- No abstractions for single-use code
- No features not in the spec
- If 200 lines could be 50, rewrite

### 3. Surgical edits only
- Only modify what's directly relevant to the current task
- Do not touch adjacent code, comments, or formatting
- No surprise refactors

### 4. Build order matters
Follow the spec build order exactly:
1. Scaffold Vite React app
2. Basic chat UI
3. Wire Gemini API
4. GitHub wiki loader
5. Voice input
6. Voice output
7. Buffer write-back
8. Railway deployment

Show result after each step. Wait for approval before next step.

## Environment
- .env already exists, do not create or modify it
- GitHub repo: wallenut/allen-wiki
- Wiki files: allen_synthesis.md, research/current_state.md, 
  fitness/current_state.md, life/current_state.md

## Testing requirement
Before marking any feature complete:
- Run the dev server (`npm run dev` + `node server.js`)
- Manually verify the new feature works end-to-end
- Confirm no existing features are broken (chat, voice, wiki load, save, review panel)
- Report exactly what was tested and what was observed

Never declare a feature done without running the app.

## On errors
- If GitHub wiki fails to load, use fallback system prompt and continue
- Do not block the UI on API failures
- Ask before trying a different approach