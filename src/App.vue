<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Moon, Monitor, PanelLeftClose, PanelLeftOpen, Plug, Plus, Sun, Unplug } from "@lucide/vue";
import Conversation from "./components/ai-elements/Conversation.vue";
import Message from "./components/ai-elements/Message.vue";
import PromptInput from "./components/ai-elements/PromptInput.vue";
import { renderMarkdown } from "./lib/markdown";
import { RpcClient, type BridgeMessage, type BridgeStatus, type PiConnectionConfig } from "./lib/rpcClient";
import {
  acknowledgeExtensionRequest,
  appendLocalUserMessage,
  createInitialSessionState,
  reduceSessionEvent,
  reduceSessionResponse,
  type ExtensionRequest,
  type SessionState
} from "./lib/sessionState";

type LocalChatSession = {
  id: string;
  title: string;
  state: SessionState;
};

type ThemePreference = "light" | "dark" | "system";

const config = reactive<PiConnectionConfig>({
  provider: "",
  model: "",
  noSession: false,
  sessionDir: "",
  extraArgs: ""
});

let generatedSessionId = 1;
let systemThemeQuery: MediaQueryList | null = null;
const localSessions = reactive<LocalChatSession[]>([createLocalSession()]);
const activeSessionId = ref(localSessions[0].id);
const prompt = ref("");
const queueMode = ref<"steer" | "follow_up">("steer");
const status = ref<BridgeStatus>("idle");
const stderr = ref<string[]>([]);
const extensionValue = ref("");
const sidebarCollapsed = ref(false);
const themePreference = ref<ThemePreference>(readThemePreference());
const messageScroller = ref<HTMLElement | null>(null);
const rpcSessionId = ref(activeSessionId.value);

const client = new RpcClient({
  onOpen: () => {
    status.value = "connected";
    syncConnectionState(true, "Bridge connected", false);
  },
  onClose: () => {
    status.value = "exited";
    syncConnectionState(false, "Connection closed", false);
  },
  onError: (message) => {
    status.value = "error";
    session.value.statusText = message;
  },
  onMessage: handleBridgeMessage
});

const activeChat = computed(() => localSessions.find((item) => item.id === activeSessionId.value) ?? localSessions[0]);
const session = computed(() => activeChat.value.state);
const isConnected = computed(() => session.value.connected);
const canSend = computed(() => isConnected.value && prompt.value.trim().length > 0);
const pendingExtension = computed(() => session.value.extensionRequests[0]);
const extensionOptions = computed(() => {
  const options = pendingExtension.value?.params.options;
  return Array.isArray(options) ? options.map(String) : [];
});
const extensionTitle = computed(() => stringParam("title") || pendingExtension.value?.method || "Extension request");
const extensionMessage = computed(() => stringParam("message") || stringParam("label"));
const extensionUsesEditor = computed(() => pendingExtension.value?.method === "input" || pendingExtension.value?.method === "editor");
const connectionLabel = computed(() => {
  if (status.value === "running") return "Pi running";
  if (isConnected.value) return "Connected";
  if (status.value === "connecting") return "Connecting";
  if (status.value === "error") return "Error";
  return "Disconnected";
});
const connectionActionLabel = computed(() => (isConnected.value ? "Disconnect" : "Connect"));
const statusBadge = computed(() => (session.value.running ? "Running" : connectionLabel.value));
const themeIcon = computed(() => ({ light: Sun, dark: Moon, system: Monitor })[themePreference.value]);
const sidebarIcon = computed(() => (sidebarCollapsed.value ? PanelLeftOpen : PanelLeftClose));
const connectionIcon = computed(() => (isConnected.value ? Unplug : Plug));
const themeTitle = computed(() => `Theme: ${themePreference.value}`);

watch(pendingExtension, (request) => {
  if (!request) {
    extensionValue.value = "";
    return;
  }

  extensionValue.value = stringParam("prefill") || stringParam("text") || extensionOptions.value[0] || "";
});

watch(
  () => [activeSessionId.value, session.value.messages.length, session.value.tools.length],
  () => {
    void scrollMessagesToEnd();
  },
  { flush: "post" }
);

watch(themePreference, (value) => {
  localStorage.setItem("agent-web-theme", value);
  applyTheme();
});

onMounted(() => {
  systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemThemeQuery.addEventListener("change", applyTheme);
  applyTheme();
});

onBeforeUnmount(() => {
  systemThemeQuery?.removeEventListener("change", applyTheme);
});

function createLocalSession(): LocalChatSession {
  const state = createInitialSessionState();
  return {
    id: `local-${generatedSessionId++}`,
    title: "New chat",
    state
  };
}

function connect() {
  status.value = "connecting";
  client.connect({ ...config });
}

function disconnect() {
  client.disconnect();
}

function toggleConnection() {
  if (isConnected.value) {
    disconnect();
  } else {
    connect();
  }
}

function newChat() {
  const nextSession = createLocalSession();
  nextSession.state.connected = isConnected.value;
  nextSession.state.running = session.value.running;
  nextSession.state.statusText = session.value.statusText;
  localSessions.unshift(nextSession);
  activeSessionId.value = nextSession.id;

  if (isConnected.value) {
    rpcSessionId.value = nextSession.id;
    client.command("new_session");
  }
}

function selectChat(id: string) {
  activeSessionId.value = id;
}

function cycleTheme() {
  const themes: ThemePreference[] = ["light", "dark", "system"];
  const currentIndex = themes.indexOf(themePreference.value);
  themePreference.value = themes[(currentIndex + 1) % themes.length];
}

function sendPrompt() {
  const message = prompt.value.trim();
  if (!message || !isConnected.value) return;

  appendLocalUserMessage(session.value, message);
  rpcSessionId.value = activeSessionId.value;
  if (activeChat.value.title === "New chat") {
    activeChat.value.title = titleFromPrompt(message);
  }

  if (session.value.turnActive) {
    client.command(queueMode.value, { message });
  } else {
    client.command("prompt", { message });
  }

  prompt.value = "";
}

function respondToExtension(request: ExtensionRequest, accepted: boolean) {
  client.command("extension_ui_response", extensionResponsePayload(request, accepted));
  acknowledgeExtensionRequest(session.value, request.id);
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
  const targetState = rpcSessionState();

  if (message.source === "bridge") {
    if (message.type === "error") {
      status.value = "error";
      targetState.statusText = message.message ?? "Bridge error";
    }
    return;
  }

  if (message.type === "status") {
    const hadError = status.value === "error";
    status.value = hadError && message.status === "exited" ? "error" : message.status === "running" ? "running" : message.status;
    const connected = message.status !== "exited";
    const statusText = message.status === "exited" ? "Pi exited" : `Pi ${message.status}`;
    syncConnectionState(connected, hadError && message.status === "exited" ? targetState.statusText : statusText, message.status === "running");
    return;
  }

  if (message.type === "event") {
    prefillEditorPrompt(message.event);
    reduceSessionEvent(targetState, message.event);
    return;
  }

  if (message.type === "response") {
    reduceSessionResponse(targetState, message.response);
    return;
  }

  if (message.type === "stderr") {
    stderr.value.unshift(message.data);
    stderr.value = stderr.value.slice(0, 20);
    return;
  }

  status.value = "error";
  targetState.statusText = message.message;
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

function syncConnectionState(connected: boolean, statusText: string, running: boolean) {
  localSessions.forEach((item) => {
    item.state.connected = connected;
    item.state.running = running;
    item.state.statusText = statusText;
  });
}

function rpcSessionState(): SessionState {
  return localSessions.find((item) => item.id === rpcSessionId.value)?.state ?? session.value;
}

function titleFromPrompt(message: string): string {
  const title = message.replace(/\s+/g, " ").trim();
  return title.length > 34 ? `${title.slice(0, 34)}...` : title || "New chat";
}

function readThemePreference(): ThemePreference {
  const stored = localStorage.getItem("agent-web-theme");
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function applyTheme() {
  const prefersDark = systemThemeQuery?.matches ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = themePreference.value === "dark" || (themePreference.value === "system" && prefersDark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

async function scrollMessagesToEnd() {
  await nextTick();
  const scroller = messageScroller.value;
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
  }
}
</script>

<template>
  <main class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <aside class="sidebar" aria-label="Sessions">
      <div class="sidebar-header">
        <button class="icon-button" type="button" :aria-label="themeTitle" :title="themeTitle" @click="cycleTheme">
          <component :is="themeIcon" :size="18" aria-hidden="true" />
        </button>
        <button class="icon-button" type="button" aria-label="New chat" title="New chat" @click="newChat">
          <Plus :size="19" aria-hidden="true" />
        </button>
      </div>

      <nav class="session-list" aria-label="Local sessions">
        <button
          v-for="item in localSessions"
          :key="item.id"
          class="session-item"
          :class="{ active: item.id === activeSessionId }"
          type="button"
          @click="selectChat(item.id)"
        >
          <span>{{ item.title }}</span>
        </button>
      </nav>

      <div class="profile-row">
        <div class="avatar">U</div>
        <div class="profile-copy">
          <strong>User</strong>
          <span>{{ session.statusText }}</span>
        </div>
        <button class="connect-button" type="button" :title="connectionActionLabel" @click="toggleConnection">
          <component :is="connectionIcon" :size="15" aria-hidden="true" />
          <span>{{ connectionActionLabel }}</span>
        </button>
      </div>
    </aside>

    <section class="main-chat">
      <header class="chat-header">
        <button class="icon-button" type="button" aria-label="Toggle sidebar" title="Toggle sidebar" @click="sidebarCollapsed = !sidebarCollapsed">
          <component :is="sidebarIcon" :size="19" aria-hidden="true" />
        </button>
        <h1>{{ activeChat.title }}</h1>
        <span class="status-pill" :class="status">{{ statusBadge }}</span>
      </header>

      <Conversation>
        <div ref="messageScroller" class="conversation-scroll">
          <div v-if="session.messages.length === 0 && session.tools.length === 0" class="welcome">
            <h2>Start a chat with Pi</h2>
            <p>Connect, then send a prompt.</p>
          </div>

          <div class="message-stack">
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
              <div class="message-markdown" v-html="renderMarkdown(message.content || '...')"></div>
            </Message>

            <div v-if="session.tools.length" class="activity-list" aria-label="Tool activity">
              <div v-for="tool in session.tools" :key="tool.id" class="tool-row" :class="tool.status">
                <span class="activity-name">{{ tool.name }}</span>
                <span>{{ tool.status }}</span>
              </div>
            </div>

            <details v-if="session.queue.length" class="inline-activity">
              <summary>{{ session.queue.length }} queued command{{ session.queue.length === 1 ? "" : "s" }}</summary>
              <ol class="compact-list">
                <li v-for="item in session.queue" :key="String(item.id ?? item.command)">
                  {{ item.label ?? item.command ?? "queued" }}
                </li>
              </ol>
            </details>

            <details v-if="stderr.length" class="inline-activity error-row">
              <summary>stderr</summary>
              <pre>{{ stderr.join('') }}</pre>
            </details>
          </div>
        </div>

        <div class="composer">
          <PromptInput
            v-model="prompt"
            :send-disabled="!canSend"
            placeholder="Send a message..."
            @submit="sendPrompt"
          />
        </div>
      </Conversation>
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
