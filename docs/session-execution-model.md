# Session Execution Model

This document captures the session execution model for Agent Web. The goal is to keep the UI predictable, preserve Pi's saved history, and make live work clearly owned by the backend.

## Core Invariants

- UI interactions that look nondestructive must not mutate server-side Pi state.
- Viewing, selecting, collapsing, refreshing, and inspecting sessions are read-only.
- Pi session history persists on disk and is the source of truth for saved messages.
- Live execution is backend-owned and targeted by a specific session ID or session path.
- Live execution must not depend on whichever session is currently selected in the browser.
- At most one runner process may be running, cancelling, or draining for a session at a time.

## Runner Service Architecture

Agent Web now runs as two local services:

- The web service serves the Vue app and keeps the browser-facing `/rpc` WebSocket protocol stable.
- The runner service owns `PiRunnerCore`, Pi child processes, session hydration, and live event routing.

Start them in separate terminals during development:

```sh
npm run dev:runner
npm run dev:web
```

The runner service binds to `127.0.0.1:4178` by default, exposes `GET /health`, and accepts the internal WebSocket at `/runner`. Use `RUNNER_HOST` and `RUNNER_PORT` to change the runner bind address, or set `RUNNER_URL` on the web service to connect to a specific runner URL.

## Preferred Architecture

Use a per-session backend runner for active turns. The runner service keeps each runner warm until it exits or the service is shut down; a stricter one-shot runner can still be introduced later if it preserves the invariants below. Browser disconnects unsubscribe clients from live events but do not stop active Pi work.

When the user sends a message:

1. The frontend sends the message for the exact target session.
2. The backend starts work for that session ID or path.
3. Switching to another UI session does not stop, retarget, or mutate the active turn.
4. Pi persists the turn to its own session history.
5. Saved messages are read back from Pi session history on disk.

This keeps session ownership explicit: the browser can observe and navigate, but the backend decides which Pi session a running turn belongs to.

## Queued Messages

If a user sends another normal message while a runner is already active for that session, the backend reuses the same runner and sends Pi a `prompt` command with `streamingBehavior`.

- `streamingBehavior: "steer"` asks Pi to deliver the message before the next model call.
- `streamingBehavior: "followUp"` asks Pi to wait until the current agent work finishes.
- The app-level `queueMode` field is stripped before forwarding the command to Pi.

The queue is per session. Work in one session should not block independent work in another session.

## Steering Messages

If a user sends a steering message that is meant to redirect the current turn for the same session:

- Prefer Pi's streaming queue behavior (`streamingBehavior: "steer"`) while the turn is active.
- Do not create a second runner for the same session.
- If a future UI action needs hard cancellation, prefer a graceful Pi cancel or abort API when one is available.
- Use a hard process kill only as a fallback.

Hard kill is a fallback because it may risk losing tail events that Pi has not flushed yet.

## Known Failure

This model is motivated by a known failure around session `019e30fc-d214-7349-8b1c-b149337ace1e`.

Switching sessions around a commit appears to have allowed a side effect to happen while the assistant and tool tail was not persisted. The important lesson is that session navigation must not control live execution, and live execution must be tied to the intended session instead of the currently viewed browser state.

## Later Optimization

A warm per-session runner with an idle TTL is acceptable later if it preserves the same invariants:

- Session targeting remains explicit.
- UI navigation stays read-only.
- Pi history remains the saved-message source of truth.
- Only one runner is active per session.
- Cleanup is reliable when the runner is idle.

## Non-goals / Deferred

- Do not start a process merely because an old session is viewed. Runner processes are created by live commands, not navigation.
- Do not make the frontend maintain its own saved-message store. Pi owns persisted session history.
- Do not let viewing, selection, refresh, collapse, or inspection actions create, resume, cancel, or retarget Pi sessions.
- Do not add process-killing steering behavior until it is clear Pi's own streaming queue is insufficient.
