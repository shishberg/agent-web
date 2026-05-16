# Model Picker — Implementation Plan

**Goal:** Add a model picker to the agent-web UI so users can choose which Pi model to use when starting a new session or mid-session, changing the default from GLM 5.1 (opencode-go) to kimi k2.6 (opencode-go) as the immediate visible outcome.

---

## Why This Matters Now

Pi's `defaultModelPerProvider` map already lists `kimi-k2.6` as the default for `opencode-go`. The problem is that agent-web never specifies a provider or model — it always sends `new_session` with no model override, so Pi falls back to whichever provider/model it "remembers" from its last session (or the global default set in the TUI). If that remembered default is `zai/glm-5.1` or an older `opencode-go/glm-5.1`, that's what you get.

A model picker lets users override this directly from the web UI, and we can set kimi k2.6 as the UI-level default.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│  Frontend (Vue)                                  │
│                                                  │
│  ┌─────────────┐    ┌──────────────────────┐    │
│  │ ModelPicker  │    │ App.vue              │    │
│  │ Component    │◄──►│  - availableModels   │    │
│  │              │    │  - selectedModel      │    │
│  └──────┬───────┘    │  - send set_model    │    │
│         │            └──────┬───────────────┘    │
│         │                   │ RpcClient           │
└─────────┼───────────────────┼────────────────────┘
          │                   │
     WebSocket /rpc            │
          │                   │
┌─────────┼───────────────────┼────────────────────┐
│  Server (Node)              │                    │
│                             │                    │
│  ┌──────────────────────────┼─────────────────┐  │
│  │ PiSessionBridge          │                 │  │
│  │  - handleClientMessage() │                 │  │
│  │  - handlePiEvent()        │                │  │
│  │  - forward get_available_models            │  │
│  │  - forward set_model      │                │  │
│  └──────────────────────────┼─────────────────┘  │
│                             │                    │
│  ┌──────────────────────────┼─────────────────┐  │
│  │ PiProcess                ▼                 │  │
│  │  - start(config)   ← provider/model flags  │  │
│  │  - send(rpcCommand)                       │  │
│  └───────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

Pi already has full RPC support for `get_available_models`, `set_model`, and `cycle_model`. The work is entirely in the bridge and frontend layers.

---

## Phase 1 — Backend: Bridge Support for Model Commands

### 1.1 Forward model-related RPC commands

**File:** `server/piSessionBridge.ts`

The `handleClientMessage` method currently handles `list_sessions`, `open_session`, `new_session`, and everything else gets forwarded to Pi via `sendPiCommand`. Model commands (`get_available_models`, `set_model`, `cycle_model`) already fall through to `sendPiCommand`, so they **already work** for an active session. No changes needed here for command forwarding.

### 1.2 Expose available models before session start

**Problem:** `get_available_models` only works after Pi starts. Users should see the model list before creating a session.

**Solution:** Start Pi immediately on first connection (even before `new_session`), or add a lightweight bridge command that starts Pi, queries models, and disconnects.

**Recommended approach — eager-start with lazy model fetch:**

1. When the frontend first connects, it sends `get_available_models` immediately.
2. If Pi isn't running yet, the bridge starts it temporarily (or the frontend sends `new_session` first, which starts Pi).
3. Pi responds with the model list; the bridge forwards it to the frontend.

**Simpler alternative (recommended for V1):** Don't show the model picker until the first session is active. The flow becomes:

1. User clicks "New chat" → `new_session` command → Pi starts with default model.
2. Once Pi is running, frontend sends `get_available_models` to populate the picker.
3. User can change model mid-session with `set_model`.

This avoids the complexity of a temporary Pi process and still solves the core problem — kimi k2.6 is one `set_model` call away.

### 1.3 Pass initial model via PiSessionConfig

**File:** `server/piSessionBridge.ts`, `server/piProcess.ts`

Already supported. `PiSessionConfig` has `provider` and `model` fields, and `buildPiArgs` maps them to `--provider` and `--model` CLI flags. The bridge just needs to accept these from the frontend and pass them through.

**Changes to `PiSessionBridge.handleClientMessage`:**

```ts
if (message.command === "new_session") {
  const version = this.beginSessionVersion();
  this.ensurePi();
  const config = extractSessionConfig(message.payload);
  this.sendPiCommand("new_session", {}, `session-${version}-new`);
  // If model was specified, send set_model after session starts
  if (config.provider || config.model) {
    this.sendPiCommand("set_model", {
      provider: config.provider,
      modelId: config.model
    }, `session-${version}-model`);
  }
  return;
}
```

**Alternative (cleaner):** Use `--provider` and `--model` CLI args in the initial `PiProcess.start()` config instead of a separate `set_model` RPC command. This means the model is set before the first prompt.

```ts
private ensurePi(config: PiSessionConfig = {}): PiProcessLike {
  // ... existing code ... 
}

// In new_session handler:
this.ensurePi({
  provider: stringPayload(message.payload, "provider") || undefined,
  model: stringPayload(message.payload, "model") || undefined
});
```

**Recommendation:** Use CLI flags for initial model (Phase 1), and `set_model` RPC for mid-session changes (Phase 2). This is simpler and matches how Pi works from the terminal.

### 1.4 Bridge message type for available models

**File:** `src/lib/rpcClient.ts`

Add a new bridge message type for the model list:

```ts
export type PiModelSummary = {
  provider: string;
  id: string;
  name?: string;
};

export type BridgeMessage =
  // ... existing types ...
  | { source: "bridge"; type: "available_models"; models: PiModelSummary[] };
```

### 1.5 Auto-request models on Pi start

**File:** `server/piSessionBridge.ts`

When Pi starts (or when `new_session` succeeds), automatically send `get_available_models` and cache/forward the result:

```ts
private async handlePiEvent(event: PiProcessEvent): Promise<void> {
  // ... existing handling ...

  if (event.type === "event" && event.event.type === "agent_end") {
    this.hydrateActiveSession();
    await this.refreshSessions();
    return;
  }
}

// After Pi responds to get_available_models:
if (response.command === "get_available_models" && response.success) {
  const models = response.data?.models ?? [];
  this.options.send({
    source: "bridge",
    type: "available_models",
    models: models.map(m => ({
      provider: m.provider,
      id: m.id,
      name: m.name
    }))
  });
}
```

---

## Phase 2 — Frontend: Model Picker Component

### 2.1 New `ModelPicker.vue` component

**File:** `src/components/ai-elements/ModelPicker.vue`

A compact dropdown that shows the current model (provider/id) and lets users pick from available models.

```
┌─────────────────────────────────┐
│ 🤖 opencode-go / kimi-k2.6  ▼ │
└─────────────────────────────────┘
  ┌─────────────────────────────┐
  │ opencode-go                 │
  │   kimi-k2.6          ✓     │
  │   glm-5.1                   │
  │   deepseek-v4-pro           │
  │ anthropic                    │
  │   claude-opus-4-7            │
  │ openai                       │
  │   gpt-5.4                    │
  └─────────────────────────────┘
```

**Template sketch:**

```vue
<script setup lang="ts">
import { computed } from "vue";
import type { PiModelSummary } from "../../lib/rpcClient";

const props = defineProps<{
  models: PiModelSummary[];
  currentProvider: string;
  currentModel: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  select: [provider: string, modelId: string];
}>();

// Group models by provider for display
const grouped = computed(() => {
  const map = new Map<string, PiModelSummary[]>();
  for (const m of props.models) {
    const list = map.get(m.provider) ?? [];
    list.push(m);
    map.set(m.provider, list);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
});
</script>
```

### 2.2 Wire into `App.vue`

**File:** `src/App.vue`

Add state and handlers:

```ts
const availableModels = ref<PiModelSummary[]>([]);
const selectedProvider = ref("opencode-go");
const selectedModel = ref("kimi-k2.6");

// Default model for new sessions — kimi k2.6 via opencode-go
const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_MODEL = "kimi-k2.6";

function handleBridgeMessage(message: BridgeMessage) {
  // ... existing handlers ...
  if (message.type === "available_models") {
    availableModels.value = message.models;
  }
}

function newChat() {
  // ... existing code ...
  client.command("new_session", {
    provider: selectedProvider.value || undefined,
    model: selectedModel.value || undefined
  });
}
```

**UI placement:** Add the model picker to the `chat-header` area, between the title and the status pill. This keeps it accessible but not dominating.

```vue
<header class="chat-header">
  <!-- sidebar toggle -->
  <h1>{{ activeTitle }}</h1>
  <ModelPicker
    :models="availableModels"
    :current-provider="sessionRuntime.provider || selectedProvider"
    :current-model="sessionRuntime.model || selectedModel"
    :disabled="!isConnected"
    @select="changeModel"
  />
  <div class="status-actions">
    <!-- status pill, info button -->
  </div>
</header>
```

### 2.3 Mid-session model switching

When the user picks a model mid-session:

```ts
function changeModel(provider: string, modelId: string) {
  selectedProvider.value = provider;
  selectedModel.value = modelId;
  if (isConnected.value) {
    client.command("set_model", { provider, modelId: modelId });
  }
}
```

This uses Pi's `set_model` RPC command (already defined in the protocol), which takes effect for the next prompt in the current session.

### 2.4 Model info in session state extraction

The `get_state` response already includes model info. The existing `applySessionRuntime` function in `App.vue` already extracts `provider` and `model` from it. The model picker should sync with this — when a session loads, the picker shows its current model.

### 2.5 Request available models on connect

```ts
onMounted(() => {
  // ... existing code ...
  client.command("list_sessions");
  // After connection opens, request models
});

// In the onOpen handler:
onOpen: () => {
  status.value = "connected";
  session.connected = true;
  session.statusText = "Bridge connected";
  client.command("get_available_models");
}
```

---

## Phase 3 — Default Model Change

### 3.1 UI-level default: kimi k2.6 via opencode-go

The simplest and most effective approach:

1. Set `selectedProvider` and `selectedModel` defaults to `"opencode-go"` and `"kimi-k2.6"` in `App.vue`.
2. Pass these as `provider`/`model` in the `new_session` payload.
3. The `new_session` bridge handler uses them in `ensurePi()` config, which passes them as `--provider opencode-go --model kimi-k2.6` CLI flags to Pi.

This means every new session starts with kimi k2.6 — no reliance on Pi's remembered default.

### 3.2 Persistence (optional enhancement)

Persist the user's last-chosen model in `localStorage`:

```ts
function readModelPreference(): { provider: string; model: string } {
  const stored = localStorage.getItem("agent-web-model");
  if (stored) {
    try { return JSON.parse(stored); } catch { /* ignore */ }
  }
  return { provider: "opencode-go", model: "kimi-k2.6" };
}

function saveModelPreference(provider: string, model: string): void {
  localStorage.setItem("agent-web-model", JSON.stringify({ provider, model }));
}
```

This way the preference survives page reloads.

---

## File Change Summary

| File | Change |
|------|--------|
| `server/piSessionBridge.ts` | Forward `provider`/`model` from `new_session` payload into `PiSessionConfig`; auto-request `get_available_models` after Pi starts; forward model list as bridge message |
| `server/piProcess.ts` | No changes — already supports `provider`/`model` in config |
| `src/lib/rpcClient.ts` | Add `PiModelSummary` type; add `available_models` bridge message variant |
| `src/lib/sessionState.ts` | No changes needed (model info already in `SessionRuntimeMetadata`) |
| `src/components/ai-elements/ModelPicker.vue` | **New file** — dropdown component for model selection |
| `src/App.vue` | Add model state (`availableModels`, `selectedProvider`, `selectedModel`); handle `available_models` bridge messages; pass model info in `newChat`; add `<ModelPicker>` to header; add `changeModel` handler; localStorage persistence |
| `src/styles.css` | Styles for `.model-picker`, dropdown, grouped model list |

---

## Implementation Order

1. **Backend bridge changes** — forward `new_session` payload with `provider`/`model`; handle `get_available_models` response; add `available_models` bridge message type
2. **Frontend state** — add `PiModelSummary` type, `availableModels` ref, model selection state, `changeModel` handler to `App.vue`
3. **ModelPicker component** — create the dropdown UI
4. **Wire it up** — integrate `ModelPicker` into `App.vue` header; pass model config to `newChat()`
5. **Default change** — set `opencode-go` / `kimi-k2.6` as the default; add localStorage persistence
6. **Styles** — add CSS for the picker
7. **Test** — `npm run typecheck && npm run build && npm run test:e2e`

---

## Open Questions

- **Grouped vs. flat list:** Should models be grouped by provider (recommended — there can be 50+ models) or shown as a flat searchable list?
- **Search/filter:** For a large model list, should the picker have a search box? (Recommended for V2, skip for V1.)
- **Unavailable models:** Pi's `get_available_models` returns only models with configured auth. Should the picker also show unconfigured providers greyed out? (No for V1 — only show what's ready to use.)
- **Mid-session model change UX:** Should changing the model reset the session, or apply to the next prompt only? Pi's `set_model` applies going forward — no reset needed. Make this clear in the UI with a small note like "Model change applies to next prompt."