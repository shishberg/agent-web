<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Moon, Monitor, PanelLeftClose, PanelLeftOpen, Plus, Sun } from "@lucide/vue";
import Conversation from "./components/ai-elements/Conversation.vue";
import Message from "./components/ai-elements/Message.vue";
import PromptInput from "./components/ai-elements/PromptInput.vue";
import { renderMarkdown } from "./lib/markdown";
import { RpcClient, type BridgeMessage, type BridgeStatus, type PiSessionSummary } from "./lib/rpcClient";
import {
  acknowledgeExtensionRequest,
  appendLocalUserMessage,
  createInitialSessionState,
  hydrateSessionMessages,
  reduceSessionEvent,
  reduceSessionResponse,
  type ExtensionRequest,
  type SessionState
} from "./lib/sessionState";

type ThemePreference = "light" | "dark" | "system";

let systemThemeQuery: MediaQueryList | null = null;
const piSessions = ref<PiSessionSummary[]>([]);
const activeSessionId = ref<string | null>(null);
const draftTitle = ref("New chat");
const session = reactive<SessionState>(createInitialSessionState());
const prompt = ref("");
const queueMode = ref<"steer" | "follow_up">("steer");
const status = ref<BridgeStatus>("idle");
const stderr = ref<string[]>([]);
const extensionValue = ref("");
const sidebarCollapsed = ref(false);
const themePreference = ref<ThemePreference>(readThemePreference());
const messageScroller = ref<HTMLElement | null>(null);

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

const activePiSession = computed(() => piSessions.value.find((item) => item.id === activeSessionId.value));
const activeTitle = computed(() => activePiSession.value?.title ?? draftTitle.value);
const isConnected = computed(() => session.connected);
const canSend = computed(() => prompt.value.trim().length > 0);
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
  if (isConnected.value) return "Connected";
  if (status.value === "connecting") return "Connecting";
  if (status.value === "error") return "Error";
  return "Disconnected";
});
const statusBadge = computed(() => (session.running ? "Running" : connectionLabel.value));
const themeIcon = computed(() => ({ light: Sun, dark: Moon, system: Monitor })[themePreference.value]);
const sidebarIcon = computed(() => (sidebarCollapsed.value ? PanelLeftOpen : PanelLeftClose));
const themeTitle = computed(() => `Theme: ${themePreference.value}`);

watch(pendingExtension, (request) => {
  if (!request) {
    extensionValue.value = "";
    return;
  }

  extensionValue.value = stringParam("prefill") || stringParam("text") || extensionOptions.value[0] || "";
});

watch(
  () => [activeSessionId.value, session.messages.length, session.tools.length],
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
  client.command("list_sessions");
});

onBeforeUnmount(() => {
  systemThemeQuery?.removeEventListener("change", applyTheme);
  disconnect();
});

function disconnect() {
  client.disconnect();
}

function newChat() {
  activeSessionId.value = null;
  draftTitle.value = "New chat";
  hydrateSessionMessages(session, []);
  session.connected = isConnected.value;
  session.statusText = "Starting new Pi session";
  client.command("new_session");
}

function selectChat(id: string) {
  const item = piSessions.value.find((candidate) => candidate.id === id);
  if (!item) return;

  activeSessionId.value = id;
  draftTitle.value = item.title;
  hydrateSessionMessages(session, []);
  session.connected = isConnected.value;
  session.statusText = "Opening session";
  client.command("open_session", { path: item.path });
}

function cycleTheme() {
  const themes: ThemePreference[] = ["light", "dark", "system"];
  const currentIndex = themes.indexOf(themePreference.value);
  themePreference.value = themes[(currentIndex + 1) % themes.length];
}

function sendPrompt() {
  const message = prompt.value.trim();
  if (!message) return;

  appendLocalUserMessage(session, message);
  if (!activeSessionId.value && draftTitle.value === "New chat") {
    draftTitle.value = titleFromPrompt(message);
  }

  if (session.turnActive) {
    client.command(queueMode.value, { message });
  } else {
    client.command("prompt", { message });
  }

  prompt.value = "";
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
    if (message.type === "sessions") {
      piSessions.value = message.sessions;
    }
    if (message.type === "session_cancelled") {
      session.statusText = message.message;
    }
    return;
  }

  if (message.type === "status") {
    const hadError = status.value === "error";
    status.value = hadError && message.status === "exited" ? "error" : message.status === "running" ? "running" : message.status;
    const connected = message.status !== "exited";
    const statusText = message.status === "exited" ? "Pi exited" : `Pi ${message.status}`;
    session.connected = connected;
    session.running = message.status === "running";
    session.statusText = hadError && message.status === "exited" ? session.statusText : statusText;
    return;
  }

  if (message.type === "event") {
    prefillEditorPrompt(message.event);
    reduceSessionEvent(session, message.event);
    return;
  }

  if (message.type === "response") {
    applyPiResponse(message.response);
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

function applyPiResponse(response: Record<string, unknown>) {
  if (response.success !== false && response.command === "get_messages") {
    const data = typeof response.data === "object" && response.data !== null ? (response.data as Record<string, unknown>) : {};
    if (Array.isArray(data.messages)) {
      hydrateSessionMessages(session, data.messages);
      session.connected = isConnected.value;
    }
  }

  if (response.success !== false && response.command === "get_state") {
    const data = typeof response.data === "object" && response.data !== null ? (response.data as Record<string, unknown>) : {};
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
    const sessionName = typeof data.sessionName === "string" ? data.sessionName : "";
    if (sessionId) {
      activeSessionId.value = sessionId;
    }
    if (sessionName && !activePiSession.value) {
      draftTitle.value = sessionName;
    }
  }

  reduceSessionResponse(session, response);
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

      <nav class="session-list" aria-label="Pi sessions">
        <button
          v-for="item in piSessions"
          :key="item.id"
          class="session-item"
          :class="{ active: item.id === activeSessionId }"
          type="button"
          :aria-label="`Chat session: ${item.title}`"
          :aria-current="item.id === activeSessionId ? 'page' : undefined"
          @click="selectChat(item.id)"
        >
          <span>{{ item.title }}</span>
        </button>
        <p v-if="piSessions.length === 0" class="session-empty">No saved sessions</p>
      </nav>

      <div class="profile-row">
        <div class="avatar">U</div>
        <div class="profile-copy">
          <strong>User</strong>
          <span>{{ session.statusText }}</span>
        </div>
      </div>
    </aside>

    <section class="main-chat">
      <header class="chat-header">
        <button class="icon-button" type="button" aria-label="Toggle sidebar" title="Toggle sidebar" @click="sidebarCollapsed = !sidebarCollapsed">
          <component :is="sidebarIcon" :size="19" aria-hidden="true" />
        </button>
        <h1>{{ activeTitle }}</h1>
        <span class="status-pill" :class="status">{{ statusBadge }}</span>
      </header>

      <Conversation>
        <div ref="messageScroller" class="conversation-scroll">
          <div v-if="session.messages.length === 0 && session.tools.length === 0" class="welcome">
            <h2>Start a chat with Pi</h2>
            <p>Send a prompt or open a saved session.</p>
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
        <select v-if="pendingExtension.method === 'select'" v-model="extensionValue" aria-label="Extension selection">
          <option v-for="option in extensionOptions" :key="option" :value="option">{{ option }}</option>
        </select>
        <textarea
          v-else-if="extensionUsesEditor"
          v-model="extensionValue"
          :placeholder="stringParam('placeholder')"
          aria-label="Extension response"
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
