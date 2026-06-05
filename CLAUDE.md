# Allen Assistant — CLAUDE.md

## What this is
A minimal personal AI assistant web app (React/Vite) that loads Allen's 
wiki from GitHub as context, supports voice in/out, and calls Gemini API.
See spec in README.md for full requirements.

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

## On errors
- If GitHub wiki fails to load, use fallback system prompt and continue
- Do not block the UI on API failures
- Ask before trying a different approach