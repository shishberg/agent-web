# Session View Protocol

## Problem

agent-web and Pi have two different models. Pi's model is an **agent execution record** —
session files, stream events, lifecycle events, extension requests, runner status.
agent-web's model is an **interactive chat view** — bubbles, thinking panels, tool
affordances, a status badge.

These models are partially fused today. Pi-specific shapes
(`{ type: "message", message: { ... } }`, `{ type: "session" }`,
id-less stream events, `agent_end`, `extension_ui_request` with `method: setStatus`)
cross multiple boundaries and reach UI code that should not know about them.

Symptoms of the mismatch include blank assistant bubbles, duplicated messages after
snapshot-plus-stream replay, id-less assistant messages dropped until reload, sessions
staying "running" after completion, fire-and-forget extension notifications blocking
sessions, and frontend components interpreting backend lifecycle events directly. Each
symptom has been patched individually. The patches hold, but the underlying coupling
makes new regressions likely.

## Goal

> Define a stable **Session View** protocol between any backend and the UI, and make
> Pi's execution model a backend-specific source that must be adapted into that
> protocol.

The rule is not "don't return raw Pi records." The rule is:

> No code outside the Pi adapter needs to know Pi's persistence or stream shapes.

## Architecture

Three layers, two interfaces:

```
Layer 1 (Pi)               Layer 2 (View Protocol)       Layer 3 (UI)
┌─────────────────────┐     ┌──────────────────────┐     ┌───────────────┐
│ Session file        │     │                      │     │ Chat bubbles  │
│ RPC stream events   │──A──▶ SessionView          │──B──▶ Thinking       │
│ Extension events    │     │ + ViewPatch[]        │     │ Tool panels    │
│ Runner status       │     │                      │     │ Status badge   │
└─────────────────────┘     └──────────────────────┘     └───────────────┘
  Concrete, evolving          Strict, typed, stable         Pure View types
```

**Interface A** is the Pi adapter. One module. Pure functions. Zero UI. It consumes
raw Pi shapes and produces `SessionView` + `ViewPatch` values. If Pi's file format,
event semantics, or lifecycle model changes, only this adapter changes.

**Interface B** is the UI contract. agent-web renders a `SessionView` and reacts to
`ViewPatch` deltas. It never imports Pi types, never unwraps session-file records,
never inspects `agent_end` or `responseId`. It sees only the stable View types.

## SessionView

The full session view model. Produced by the adapter for snapshots; the UI hydrates
from it directly.

```ts
type SessionView = {
  session: SessionSummary;
  items: ConversationItem[];
  status: RunStatus;
  statusText: string;
  pendingRequests: UserRequest[];
  extensionDraft: string | null;
  cursor: string;
};
```

### ConversationItem

The UI's display model. Not "whatever Pi emitted."

```ts
type ConversationItem =
  | UserMessageItem
  | AssistantMessageItem
  | ToolItem
  | SystemNoticeItem;

type BaseItem = {
  id: string;
  timestamp?: number;
};

type UserMessageItem = BaseItem & {
  kind: "user";
  content: ContentBlock[];
};

type AssistantMessageItem = BaseItem & {
  kind: "assistant";
  content: ContentBlock[];
  thinking?: ContentBlock[];
  provider?: string;
  model?: string;
  usage?: UsageInfo;
};

type ToolItem = BaseItem & {
  kind: "tool";
  toolName: string;
  toolLabel: string;
  detail?: string;
  input: unknown;
  output: unknown;
  status: "running" | "done" | "error";
};

type SystemNoticeItem = BaseItem & {
  kind: "notice";
  text: string;
  noticeType: "compaction" | "retry" | "model_change" | "info";
};
```

### RunStatus

```ts
type RunStatus =
  | "idle"
  | "connecting"
  | "running"
  | "blocked"
  | "failed"
  | "stopped";
```

## ViewPatch

Stream deltas. A Sequence of these, applied to a `SessionView`, produces the next state.
The UI applies patches as they arrive and re-renders.

```ts
type ViewPatch =
  | { type: "appendItem"; item: ConversationItem }
  | { type: "updateItem"; id: string; partial: Partial<ConversationItem> }
  | { type: "setStatus"; status: RunStatus; statusText?: string }
  | { type: "setPendingRequest"; request: UserRequest }
  | { type: "clearPendingRequest"; id: string }
  | { type: "setExtensionDraft"; text: string }
  | { type: "setCursor"; cursor: string }
  | { type: "setSession"; session: SessionSummary };
```

## Pi adapter

One module: `src/protocol/pi-adapter.ts`. Exports two functions.

```ts
piSnapshotToView(raw: PiRecord[]): SessionView
piStreamEventToPatch(event: PiStreamEvent): ViewPatch | null
```

`piSnapshotToView` normalizes a Pi session file into a `SessionView`:

- Unwraps `{ type: "message", message: { ... } }` records into `ConversationItem`s.
- Preserves wrapper-level `id` / `timestamp` / `responseId` as fallbacks.
- Skips non-message metadata records (`session`, `model_change`, `thinking_level_change`).
- Derives initial `status` from the last known session status.

`piStreamEventToPatch` converts one Pi stream event into zero or one `ViewPatch`:

| Pi event | ViewPatch |
|---|---|
| `message_start` (no id) | `appendItem` with synthetic id from timestamp/responseId |
| `message_update` | `updateItem` with content delta |
| `message_end` | `updateItem` finalizing content |
| `tool_execution_start` | `appendItem` (tool) |
| `tool_execution_update` | `updateItem` (tool output) |
| `tool_execution_end` | `updateItem` (tool done) |
| `agent_start` | `setStatus("running")` |
| `agent_end` | `setStatus("connected")` |
| `turn_start` / `turn_end` | internal bookkeeping only |
| `extension_ui_request` (dialog) | `setPendingRequest` |
| `extension_ui_request` (notification) | `setStatus` text update, no blocking |
| `set_editor_text` | `setExtensionDraft` |
| `compaction_start` / `auto_retry_start` | `appendItem` (notice) or statusText |

## Fixtures

Real Pi session files and stream logs, stripped of secrets, stored as test fixtures:

```
src/protocol/fixtures/
  web-test-session.json          # session file with metadata + wrapped messages
  idless-assistant-stream.jsonl  # stream without message.id
  tool-stream.jsonl              # stream with tool calls
  extension-notifications.jsonl  # fire-and-forget extension events
  extension-dialog.jsonl         # blocking extension events
```

Each fixture has a corresponding expected `SessionView` or `ViewPatch[]` snapshot.
Tests assert the adapter produces the expected output.

## Backend responsibilities

Every `SessionManager` implementation produces `SessionView`, not raw records.

### PiDirectSessionManager

```ts
async openSession(id: string): Promise<SessionSnapshot> {
  const persisted = this.openSessionFn(session.sessionPath);
  const context = persisted.buildSessionContext();
  return {
    session: this.toSummary(session),
    view: piSnapshotToView(context.messages),
    streamCursor: session.streamCursor,
  };
}
```

### VerandahSessionManager

```ts
async openSession(id: string): Promise<SessionSnapshot> {
  const snapshot = await this.#client.snapshotSession(id);
  return {
    session: await this.#toSummary(snapshot.session),
    view: piSnapshotToView(snapshot.messages),
    streamCursor: snapshot.streamCursor,
  };
}
```

### RpcSessionManager (browser)

Trusts the contract. Parses the wire response and passes the `SessionView` through.
No normalization, no unwrapping.

### SessionSnapshot

Updated type:

```ts
type SessionSnapshot = {
  session: SessionSummary;
  view: SessionView;
};
```

`messages: unknown[]` is removed.

## UI changes

The UI reducer becomes a pure `SessionView` → render pass. It no longer interprets
Pi events directly. `ViewPatch` application is a separate reducer.

```ts
function applyViewPatch(view: SessionView, patch: ViewPatch): SessionView;
```

The App component feeds `piStreamEventToPatch` → `applyViewPatch` in its stream
handler. It never sees raw Pi event shapes.

## Tests

### Adapter tests

- `piSnapshotToView(web-test-session)` returns `view.items` with exactly two entries.
- First item is a user message containing "Say hello from Verandah web".
- Second item is an assistant message containing "Hello from Verandah web.".
- No item has `type: "message"` or nested `message` field.
- `piStreamEventToPatch` handles id-less `message_start` / `message_update` / `message_end`.
- `piStreamEventToPatch` drops fire-and-forget extension events.
- `piStreamEventToPatch` emits `setPendingRequest` for dialog extension events.

### Backend contract tests

A shared assertion, run against every `SessionManager` implementation:

```ts
function expectValidSessionView(view: SessionView): void {
  for (const item of view.items) {
    expect(item.id).toBeTruthy();
    expect(item.kind).toMatch(/user|assistant|tool|notice/);
    // No raw Pi shapes leaked
    expect(item).not.toHaveProperty("type");
    expect(item).not.toHaveProperty("message");
  }
}
```

### Browser smoke test

Opens a persisted session (seeded from `web-test-session.json`) and asserts visible text:

```ts
await page.getByRole("button", { name: /web-test/ }).click();
await expect(page.getByText("Say hello from Verandah web")).toBeVisible();
await expect(page.getByText("Hello from Verandah web.")).toBeVisible();
```

## Migration sequence

1. ✅ Define `SessionView`, `ViewPatch`, `ConversationItem` types in agent-web protocol layer.
2. ✅ Create `pi-adapter.ts` with `piSnapshotToView` and `piStreamEventToPatch`.
3. ✅ Move existing normalizer logic into the adapter; remove separate `normalizeTranscript`.
   — `normalizeStreamEvent` and `normalizeTranscript` are now private functions inside `pi-adapter.ts`.
   — `src/lib/transcriptNormalizer.ts` deleted.
4. ✅ Add fixtures from real Pi logs.
5. ✅ Write adapter tests against fixtures.
6. ✅ Change `SessionSnapshot` to carry `view: SessionView` instead of `messages: unknown[]`.
7. ✅ Update PiDirectSessionManager to call `piSnapshotToView`.
8. ✅ Update VerandahSessionManager to call `piSnapshotToView`.
9. ✅ Create `applyViewPatch` reducer; update UI stream handler to use `piStreamEventToPatch`.
10. ✅ Remove all UI-side Pi event interpretation and transcript normalization.
    — `piDirectSessionManager` and `rpcSessionManager` no longer call `normalizeStreamEvent`.
    — App.vue no longer imports `reduceSessionEvent`, `hydrateSessionMessages`, or handles
      `user_request.created` raw-Pi branch. All raw Pi shape handling is centralized in
      `src/protocol/pi-adapter.ts`.
    — `sessionStatus.ts` no longer interprets raw Pi events (`pi.event` / `user_request.created`).
    — Legacy functions (`reduceSessionEvent`, `hydrateSessionMessages`) remain exported but
      are not used by the UI; they exist for test backward compatibility only.
11. ✅ Add backend contract test helper; run against PiDirect and Verandah.
12. ✅ Add browser smoke assertion for persisted transcript text.
13. ✅ Remove `normalizeTranscript` from agent-web public exports once all consumers migrated.

### Remaining migration items

- `reduceSessionEvent` is still exported from `sessionState.ts` but is unused in production;
  future work should remove it and its legacy tests.
- `hydrateSessionMessages` is still exported but unused in production; same.
- The e2e test at `tests/e2e/chat-ui.spec.ts:852` still uses `user_request.created` as a
  mock stream event; update to `pi.event` with `extension_ui_request` payload.

## Acceptance criteria

- ✅ `SessionSnapshot` carries a typed `SessionView`, never `unknown[]`.
- ✅ No UI code unwraps `{ type: "message", message: ... }` or inspects Pi lifecycle events.
- ✅ PiDirect and Verandah call the same `piSnapshotToView`.
- ✅ Fixtures matching real `web-test` data are tested.
- ✅ Browser smoke test asserts visible bubble text.
- ✅ A backend returning raw Pi records fails contract tests at build time.

## Implementation notes (final)

### Actual module layout

```
src/
  protocol/
    types.ts             — SessionView, ConversationItem, ViewPatch, etc.
    contract.ts          — assertValidSessionView, assertNoRawPiRecords
    view-reducer.ts      — applyViewPatch (pure SessionView → SessionView)
    pi-adapter.ts        — piSnapshotToView, piStreamEventToPatch
                           (private: normalizeStreamEvent, normalizeTranscript)
    fixtures/            — Real Pi session files and stream logs (seeded)
  lib/
    sessionApi.ts        — SessionSnapshot (with view: SessionView), SessionManager interface
    sessionState.ts      — reduceSessionViewPatch + hydrateSessionFromView
                           (legacy reduceSessionEvent / hydrateSessionMessages
                           remain exported for test compat, unused in production)
    rpcSessionManager.ts — HTTP/RPC SessionManager (delegates normalization to adapter)
  sessionProtocolEntry.ts — Public subpath export (no Vue, no CSS)
  index.ts               — Main package entry (Vue app + session manager)
```

### Key design invariants

1. **Only `pi-adapter.ts` knows Pi wire shapes.**  `normalizeStreamEvent` and
   `normalizeTranscript` are private to that module; no other module imports them.

2. **Session managers produce raw events; the adapter converts.**
   `piDirectSessionManager` and `rpcSessionManager` emit `StreamEvent` objects
   with raw Pi payloads.  The App stream handler routes them through
   `piStreamEventToPatch` → `applyViewPatch` → `reduceSessionViewPatch`.
   Session managers no longer call `normalizeStreamEvent` directly.

3. **Snapshot normalization happens once.**  `piSnapshotToView` calls
   `normalizeTranscript` internally.  Backends pass raw records directly;
   there is no pre-normalization step.

4. **Contract tests enforce the boundary.**  `assertNoRawPiRecords` rejects
   any `ConversationItem` that carries `type`, `message`, `responseId`,
   or `stopReason` — all raw Pi shape indicators.
