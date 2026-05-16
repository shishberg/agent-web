# Session Execution Model

This document captures the session execution model for Agent Web. The goal is to keep the UI predictable, preserve Pi's saved history, and make live work clearly owned by the backend.

## Core Invariants

- UI interactions that look nondestructive must not mutate server-side Pi state.
- Viewing, selecting, collapsing, refreshing, and inspecting sessions are read-only.
- Pi session history persists on disk and is the source of truth for saved messages.
- Live execution is backend-owned and targeted by a specific session ID or session path.
- Live execution must not depend on whichever session is currently selected in the browser.
- At most one runner process may be running, cancelling, or draining for a session at a time.

## Preferred Architecture

Use a per-session backend runner for active turns, with a one-shot process as the baseline behavior.

When the user sends a message:

1. The frontend sends the message for the exact target session.
2. The backend starts work for that session ID or path.
3. Switching to another UI session does not stop, retarget, or mutate the active turn.
4. The runner exits after the turn is complete and the result has been persisted by Pi.
5. Saved messages are read back from Pi session history on disk.

This keeps session ownership explicit: the browser can observe and navigate, but the backend decides which Pi session a running turn belongs to.

## Queued Messages

If a user sends another normal message while a runner is already active for that session:

- Queue the new message behind the current runner.
- Let the current turn finish and persist.
- Start a new one-shot runner for the queued message against the same session.

The queue is per session. Work in one session should not block independent work in another session.

## Steering Messages

If a user sends a steering message that is meant to redirect the current turn for the same session:

- Interrupt or cancel the current runner for that session.
- Prefer a graceful Pi cancel or abort API when one is available.
- Use a hard process kill only as a fallback.
- Start a new runner for the steering message only after cancellation has completed and any final Pi events have been flushed or accounted for.

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

- Do not default to a persistent process for every old session. Lifecycle cleanup gets harder, and the baseline should stay simpler.
- Do not make the frontend maintain its own saved-message store. Pi owns persisted session history.
- Do not let viewing, selection, refresh, collapse, or inspection actions create, resume, cancel, or retarget Pi sessions.
- Do not solve the warm-runner optimization until the one-shot model is correct and observable.
