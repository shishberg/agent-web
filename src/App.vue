<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import Conversation from "./components/ai-elements/Conversation.vue";
import Message from "./components/ai-elements/Message.vue";
import PromptInput from "./components/ai-elements/PromptInput.vue";
import { RpcClient, type BridgeMessage, type BridgeStatus, type PiConnectionConfig } from "./lib/rpcClient";
import {
  acknowledgeExtensionRequest,
  createInitialSessionState,
  reduceSessionEvent,
  reduceSessionResponse,
  type ExtensionRequest
} from "./lib/sessionState";

const config = reactive<PiConnectionConfig>({
  provider: "",
  model: "",
  noSession: false,
  sessionDir: "",
  extraArgs: ""
});

const session = reactive(createInitialSessionState());
const prompt = ref("");
const queueMode = ref<"steer" | "follow_up">("steer");
const status = ref<BridgeStatus>("idle");
const stderr = ref<string[]>([]);
const extensionValue = ref("");

const client = new RpcClient({
  onOpen: () => {
    status.value = "connected";
    session.connected = true;
    session.statusText = "Bridge connected";
  },
  onClose: () => {
    status.value = "exited";
    session.connected = false;
    session.running = false;
    session.statusText = "Connection closed";
  },
  onError: (message) => {
    status.value = "error";
    session.statusText = message;
  },
  onMessage: handleBridgeMessage
});

const canSend = computed(() => session.connected && prompt.value.trim().length > 0);
const pendingExtension = computed(() => session.extensionRequests[0]);
const extensionOptions = computed(() => {
  const options = pendingExtension.value?.params.options;
  return Array.isArray(options) ? options.map(String) : [];
});
const extensionTitle = computed(() => stringParam("title") || pendingExtension.value?.method || "Extension request");
const extensionMessage = computed(() => stringParam("message") || stringParam("label"));
const extensionUsesEditor = computed(() => pendingExtension.value?.method === "input" || pendingExtension.value?.method === "editor");
const connectionLabel = computed(() => {
  if (status.value === "running") return "Pi running";
  if (session.connected) return "Connected";
  return "Disconnected";
});

watch(pendingExtension, (request) => {
  if (!request) {
    extensionValue.value = "";
    return;
  }

  extensionValue.value = stringParam("prefill") || stringParam("text") || extensionOptions.value[0] || "";
});

function connect() {
  status.value = "connecting";
  client.connect({ ...config });
}

function disconnect() {
  client.disconnect();
}

function sendPrompt() {
  const message = prompt.value.trim();
  if (!message) return;

  if (session.turnActive) {
    client.command(queueMode.value, { message });
  } else {
    client.command("prompt", { message });
  }

  prompt.value = "";
}

function sendSimple(command: string, payload: Record<string, unknown> = {}) {
  client.command(command, payload);
}

function setAutoRetry() {
  session.autoRetry = !session.autoRetry;
  client.command("set_auto_retry", { enabled: session.autoRetry });
}

function setAutoCompaction() {
  session.autoCompaction = !session.autoCompaction;
  client.command("set_auto_compaction", { enabled: session.autoCompaction });
}

function respondToExtension(request: ExtensionRequest, accepted: boolean) {
  client.command("extension_ui_response", extensionResponsePayload(request, accepted));
  acknowledgeExtensionRequest(session, request.id);
  extensionValue.value = "";
}

function extensionResponsePayload(request: ExtensionRequest, accepted: boolean): Record<string, unknown> {
  if (!accepted) {
    return { id: request.id, cancelled: true };
  }

  if (request.method === "confirm") {
    return { id: request.id, confirmed: true };
  }

  return { id: request.id, value: extensionValue.value };
}

function stringParam(key: string): string {
  const value = pendingExtension.value?.params[key];
  return typeof value === "string" ? value : "";
}

function handleBridgeMessage(message: BridgeMessage) {
  if (message.source === "bridge") {
    if (message.type === "error") {
      status.value = "error";
      session.statusText = message.message ?? "Bridge error";
    }
    return;
  }

  if (message.type === "status") {
    const hadError = status.value === "error";
    status.value = hadError && message.status === "exited" ? "error" : message.status === "running" ? "running" : message.status;
    session.connected = message.status !== "exited";
    session.running = message.status === "running";
    if (!(hadError && message.status === "exited")) {
      session.statusText = message.status === "exited" ? "Pi exited" : `Pi ${message.status}`;
    }
    return;
  }

  if (message.type === "event") {
    prefillEditorPrompt(message.event);
    reduceSessionEvent(session, message.event);
    return;
  }

  if (message.type === "response") {
    reduceSessionResponse(session, message.response);
    return;
  }

  if (message.type === "stderr") {
    stderr.value.unshift(message.data);
    stderr.value = stderr.value.slice(0, 20);
    return;
  }

  status.value = "error";
  session.statusText = message.message;
}

function prefillEditorPrompt(event: Record<string, unknown>) {
  if (event.type !== "extension_ui_request" || event.method !== "set_editor_text") {
    return;
  }

  const params = typeof event.params === "object" && event.params !== null ? (event.params as Record<string, unknown>) : event;
  const text = typeof params.text === "string" ? params.text : "";
  if (text) {
    prompt.value = text;
  }
}
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <h1>Pi Agent Workbench</h1>
        <p>{{ session.statusText }}</p>
      </div>
      <div class="status-pill" :class="status">{{ connectionLabel }}</div>
    </header>

    <section class="workspace">
      <aside class="sidebar">
        <section class="panel">
          <h2>Connection</h2>
          <label>
            Provider
            <input v-model="config.provider" placeholder="default" />
          </label>
          <label>
            Model
            <input v-model="config.model" placeholder="default" />
          </label>
          <label>
            Session dir
            <input v-model="config.sessionDir" placeholder="Pi default" />
          </label>
          <label>
            Extra args
            <input v-model="config.extraArgs" placeholder="--flag value" />
          </label>
          <label class="check-row">
            <input v-model="config.noSession" type="checkbox" />
            <span>No session</span>
          </label>
          <div class="button-row">
            <button @click="connect">Connect</button>
            <button class="secondary" :disabled="!session.connected" @click="disconnect">Disconnect</button>
          </div>
        </section>

        <section class="panel">
          <h2>Controls</h2>
          <div class="button-grid">
            <button :disabled="!session.connected" @click="sendSimple('abort')">Abort</button>
            <button :disabled="!session.connected" @click="sendSimple('new_session')">New session</button>
            <button :disabled="!session.connected" @click="sendSimple('compact')">Compact</button>
            <button :disabled="!session.connected" @click="sendSimple('get_state')">Get state</button>
          </div>
          <label class="check-row">
            <input :checked="session.autoRetry" type="checkbox" @change="setAutoRetry" />
            <span>Auto retry</span>
          </label>
          <label class="check-row">
            <input :checked="session.autoCompaction" type="checkbox" @change="setAutoCompaction" />
            <span>Auto compaction</span>
          </label>
        </section>

        <section class="panel">
          <h2>Queue</h2>
          <div v-if="session.queue.length === 0" class="empty">No queued commands</div>
          <ul v-else class="queue-list">
            <li v-for="item in session.queue" :key="String(item.id ?? item.command)">
              <span>{{ item.command ?? item.label ?? "queued" }}</span>
            </li>
          </ul>
        </section>
      </aside>

      <Conversation>
        <div class="conversation-scroll">
          <div v-if="session.messages.length === 0" class="welcome">
            <h2>Start a Pi RPC session</h2>
            <p>Connect to a local Pi install, then send a prompt. Streaming output, tools, queue updates, and extension dialogs will appear here.</p>
          </div>
          <Message
            v-for="message in session.messages"
            :key="message.id"
            :role="message.role"
            :streaming="message.status === 'streaming'"
          >
            <details v-if="message.thinking" class="thinking">
              <summary>Thinking</summary>
              <pre>{{ message.thinking }}</pre>
            </details>
            <p>{{ message.content || "..." }}</p>
            <pre v-for="delta in message.toolDeltas" :key="delta" class="delta">{{ delta }}</pre>
          </Message>
        </div>

        <div class="composer">
          <div class="composer-options">
            <label>
              While streaming
              <select v-model="queueMode">
                <option value="steer">Steer current turn</option>
                <option value="follow_up">Queue follow-up</option>
              </select>
            </label>
          </div>
          <PromptInput v-model="prompt" :disabled="!session.connected" placeholder="Ask Pi to inspect, edit, explain, or run a task..." @submit="sendPrompt" />
        </div>
      </Conversation>

      <aside class="rightbar">
        <section class="panel tools-panel">
          <h2>Tools</h2>
          <div v-if="session.tools.length === 0" class="empty">No tool activity</div>
          <article v-for="tool in session.tools" :key="tool.id" class="tool-card" :class="tool.status">
            <div class="tool-header">
              <strong>{{ tool.name }}</strong>
              <span>{{ tool.status }}</span>
            </div>
            <pre v-if="tool.input">{{ JSON.stringify(tool.input, null, 2) }}</pre>
            <pre v-if="tool.log.length">{{ tool.log.join('\n') }}</pre>
            <pre v-if="tool.output">{{ typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2) }}</pre>
          </article>
        </section>

        <section class="panel">
          <h2>Activity</h2>
          <ol class="activity-list">
            <li v-for="item in session.activity" :key="item.id">
              <time>{{ item.time }}</time>
              <span>{{ item.summary }}</span>
            </li>
          </ol>
        </section>

        <section v-if="stderr.length" class="panel stderr">
          <h2>stderr</h2>
          <pre>{{ stderr.join('') }}</pre>
        </section>
      </aside>
    </section>

    <div v-if="pendingExtension" class="modal-backdrop">
      <section class="modal">
        <h2>{{ extensionTitle }}</h2>
        <p v-if="extensionMessage">{{ extensionMessage }}</p>
        <select v-if="pendingExtension.method === 'select'" v-model="extensionValue">
          <option v-for="option in extensionOptions" :key="option" :value="option">{{ option }}</option>
        </select>
        <textarea
          v-else-if="extensionUsesEditor"
          v-model="extensionValue"
          :placeholder="stringParam('placeholder')"
          rows="6"
        />
        <div class="button-row">
          <button @click="respondToExtension(pendingExtension, true)">
            {{ pendingExtension.method === "confirm" ? "Confirm" : "Submit" }}
          </button>
          <button class="secondary" @click="respondToExtension(pendingExtension, false)">Cancel</button>
        </div>
      </section>
    </div>
  </main>
</template>
