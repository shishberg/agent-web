# Pi Runner Service Plan

## Problem Statement

Agent Web currently serves the browser UI and owns Pi runner processes from the same Node server. `server/index.ts` accepts the browser WebSocket at `/rpc`, creates a `PiSessionBridge` per socket, and that bridge starts `PiProcess` children as commands arrive. This works for a single browser connection, but the lifetime of live Pi work is still too close to the browser and web server connection that happened to start it.

The target is option 2: move live Pi execution to a separate long-lived runner service. The web server should stay a thin UI gateway, while the runner service owns active Pi processes, per-session queueing, session hydration, and recovery-friendly runtime state.

This plan keeps the current session execution model intact:

- Pi session history on disk remains the saved-message source of truth.
- Browser navigation remains read-only.
- Live execution is targeted by an explicit session path or by a new-session target.
- A browser disconnect does not stop an active Pi turn unless the user explicitly asks to cancel it.

## Chosen Architecture

Run Agent Web as two cooperating services:

- **Web service:** serves the Vue app and keeps the browser-facing `/rpc` WebSocket shape stable.
- **Runner service:** a long-lived local service that owns Pi child processes and Pi session state.

The first implementation should keep the browser protocol mostly unchanged. The browser still connects to `/rpc` and sends `{ type: "command", command, payload }`. The web service forwards validated commands to the runner service and relays runner events back to the correct browser sockets.

Use a local WebSocket or HTTP-plus-SSE connection between the web service and runner service. Prefer an internal WebSocket first because the existing code already streams JSON envelopes over WebSocket, and runner events map cleanly to the current `BridgeMessage` union.

The new ownership line:

- `server/index.ts` owns HTTP, Vite/static serving, origin checks, and browser socket lifecycle.
- A new runner client in the web service owns reconnecting to the runner service and routing envelopes between browser sockets and runner subscriptions.
- The runner service owns the logic currently centered in `PiSessionBridge`, `PiProcess`, `JsonlFramer`, and `SessionManager` access.

## Responsibilities

### Browser UI

- Keep sending explicit session targets through `sessionPath` when prompting or responding to extension UI requests.
- Keep opening saved sessions through `open_session` without starting live work.
- Keep treating Pi history hydration responses as authoritative saved state.
- Ignore Pi events whose `sessionPath` does not match the currently selected session.

### Web Service

- Serve the app and terminate browser WebSockets at `/rpc`.
- Validate message shape and origin as it does today.
- Assign each browser socket a stable `clientId`.
- Forward commands to the runner with `clientId` and optional subscription context.
- Relay runner envelopes back to subscribed browser sockets.
- Do not spawn Pi processes or read/write Pi session history directly after the migration is complete.

### Runner Service

- Own all Pi process lifetimes.
- Enforce one active runner per session key.
- Keep active turns alive across browser disconnects.
- Track which clients are subscribed to session list updates and per-session event streams.
- Serve read-only session list and saved-session hydration through `SessionManager`.
- Convert app-level queue modes to Pi `streamingBehavior` before forwarding prompts.
- Refresh session summaries after Pi work completes or session metadata changes.
- Expose a health endpoint or status command for local development and deployment checks.

### Pi Process Adapter

- Keep `PiProcess` focused on spawning Pi in `--mode rpc`, framing JSONL, forwarding stderr, and reporting lifecycle errors.
- Keep command construction and argument handling close to the adapter.
- Avoid browser or web-routing concerns in the adapter.

## Protocol Sketch

Browser to web service stays close to the current shape:

```json
{ "type": "command", "command": "prompt", "payload": { "message": "Hi", "sessionPath": "/path/session.jsonl" } }
```

Web service to runner service adds routing metadata:

```json
{
  "type": "client_command",
  "clientId": "browser-123",
  "command": "prompt",
  "payload": {
    "message": "Hi",
    "sessionPath": "/path/session.jsonl",
    "queueMode": "steer"
  }
}
```

Runner service to web service reuses the current outbound envelopes where possible:

```json
{
  "type": "client_event",
  "clientId": "browser-123",
  "message": {
    "source": "pi",
    "sessionPath": "/path/session.jsonl",
    "type": "event",
    "event": { "type": "turn_start" }
  }
}
```

For broadcasts such as session list refreshes:

```json
{
  "type": "broadcast",
  "topic": "sessions",
  "message": {
    "source": "bridge",
    "type": "sessions",
    "sessions": []
  }
}
```

Subscription commands should be explicit:

- `list_sessions`: subscribe the client to session list updates and send the current list.
- `open_session`: hydrate the requested saved session for that client only; do not start a Pi process.
- `prompt`: subscribe the client to the target session stream, ensure the session runner exists, and send the prompt.
- `new_session`: subscribe the client to the default new-session stream, ensure the default runner exists, and ask Pi to create a session.
- `extension_ui_response`: route to the runner for the request's `sessionPath` when present; otherwise use a runner-side request-id-to-runner map built when the `extension_ui_request` event is emitted.
- Browser `{ "type": "disconnect" }`: web service sends a runner unsubscribe envelope such as `{ "type": "client_disconnected", "clientId": "browser-123" }`; the runner removes client subscriptions only and does not stop active Pi work.

Include a runner protocol version in the initial handshake:

```json
{ "type": "hello", "protocolVersion": 1 }
```

The web service should fail fast with a clear bridge error if the runner protocol version is unsupported.

## Implementation Phases

### Phase 1: Extract a Runner Core

- Move the non-HTTP parts of `PiSessionBridge` behind a runner-core interface.
- Keep existing tests around session targeting, queue behavior, stale hydration suppression, extension responses, and session refreshes.
- Make browser disconnect handling configurable so the web server can remove a client without stopping runner-owned Pi processes.
- Preserve the current in-process behavior while the code is being split.

### Phase 2: Add the Runner Service Process

- Add a `server/runnerService.ts` entry point.
- Host an internal WebSocket endpoint for web-service commands.
- Instantiate one runner core for the service process.
- Add health/status handling and structured startup logs.
- Add npm scripts for local development, for example `dev:runner` and a combined dev script if useful.

### Phase 3: Add the Web-to-Runner Client

- Replace direct `new PiSessionBridge(...)` construction in `server/index.ts` with a runner client.
- Keep `/rpc` stable for the browser.
- Add reconnect behavior that reports a bridge error to browsers while the runner is unavailable.
- Ensure browser socket close sends an unsubscribe/disconnect command to the runner without stopping Pi.

### Phase 4: Preserve Runtime Semantics

- Verify that prompts for different saved sessions use different runner keys.
- Verify that second prompts for an active session map `queueMode` to Pi `streamingBehavior`.
- Verify that `open_session` only hydrates saved history and does not start a Pi process.
- Alias or migrate the default new-session runner to the saved session path once Pi reports the new session state, so later prompts by `sessionPath` reuse the same runner.
- Track extension UI request IDs to their owning runner so responses without `sessionPath` still route to the right Pi process.
- Verify that `agent_end` triggers saved-message hydration and session list refresh.
- Verify that stale hydration responses are still ignored.

### Phase 5: Operational Polish

- Document local startup and environment variables.
- Decide whether the runner service is started manually, by a process manager, or as a child process in development only.
- Add graceful shutdown handling so the runner can stop idle Pi processes and avoid cutting off active turns unexpectedly.
- Add lightweight observability: connected clients, active session runners, active turns, and last Pi error.

## Testing and QA

Use tests at each phase instead of relying on manual browser checks.

- Unit-test the extracted runner core with the existing fake Pi process tests.
- Unit-test the web-to-runner client with a fake runner server and reconnect/error cases.
- Add protocol tests for `client_command`, `client_event`, `broadcast`, handshake version mismatch, and malformed messages.
- Keep current `piSessionBridge` behavior tests until their coverage has moved to runner-core tests.
- Add regression tests that a `new_session` runner is reused after the session path becomes known and that extension UI responses route correctly with and without `sessionPath`.
- Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:e2e` before calling the migration done.
- Manually QA with `HOST=0.0.0.0 npm run dev` plus the runner service: start a new chat, open an old chat, prompt two different saved sessions, send a steering prompt during an active turn, disconnect and reconnect the browser during a running turn, and confirm Pi history still hydrates from disk.

## Risks and Open Questions

- **Runner availability:** the web app needs a clear disconnected state when the runner service is down or restarting.
- **Subscription replay:** decide whether reconnecting browsers should receive only future events or a small runner-side snapshot of active turn state.
- **Default new-session runner:** decide the exact event or response that confirms the saved session path, then alias the default runner immediately.
- **Multiple web service instances:** if more than one web service connects to the same runner, client IDs must be globally unique within the runner.
- **Process cleanup:** active turns should not be killed on browser disconnect, but idle runners still need a TTL or explicit cleanup path.
- **Security boundary:** the internal runner endpoint should bind to localhost by default and reject unexpected origins or missing shared tokens if exposed beyond localhost.
- **Backpressure:** large Pi event bursts should not let one slow browser block the runner or other clients.

## Explicit Invariants

- Viewing, selecting, collapsing, refreshing, and inspecting sessions are read-only.
- `open_session` reads persisted Pi history and must not create, resume, cancel, or retarget a Pi process.
- Every live command is routed by an explicit session key: saved-session path when present, otherwise the default new-session key.
- Once a new session has a saved path, that path must resolve to the existing runner instead of creating a second runner.
- At most one Pi runner may be running, cancelling, or draining for a given session key.
- A browser disconnect removes subscriptions but does not stop active Pi work.
- Pi session history on disk remains the source of truth for saved messages.
- The frontend must not maintain its own saved-message store.
- Runner events must include `sessionPath` when they belong to a saved session, so the browser can ignore non-active session events.
- Queue mode is an app-level field and must not be forwarded to Pi.
- Hard process termination is only a fallback after graceful Pi cancellation is unavailable or fails.
