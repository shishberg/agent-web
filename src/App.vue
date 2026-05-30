<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Eye, EyeOff, Info, Moon, Monitor, PanelLeftClose, PanelLeftOpen, Plus, Sun, X } from "@lucide/vue";
import Conversation from "./components/ai-elements/Conversation.vue";
import Message from "./components/ai-elements/Message.vue";
import PromptInput from "./components/ai-elements/PromptInput.vue";
import Shimmer from "./components/ai-elements/Shimmer.vue";
import { renderMarkdown } from "./lib/markdown";
import type { PiSessionSummary } from "./lib/rpcClient";
import { getSessionManager } from "./lib/sessionManagerInstance";
import type { SessionManager, SessionSummary, StreamEvent, Unsubscribe } from "./lib/sessionApi";
import { applyViewPatch } from "./protocol/view-reducer";
import { piStreamEventToPatch } from "./protocol/pi-adapter";
import { createEmptySessionView, type SessionView } from "./protocol/types";
import {
  acknowledgeExtensionRequest,
  appendLocalUserMessage,
  createInitialSessionState,
  hydrateSessionFromView,
  hydrateSessionMessages,
  reduceSessionEvent,
  reduceSessionResponse,
  reduceSessionViewPatch,
  type ExtensionRequest,
  type SessionMessage,
  type SessionState
} from "./lib/sessionState";
import {
  connectionLabel,
  createInitialSessionStatus,
  reduceSessionStatusEvent,
  reduceSessionStatusFromPatch,
  setConnected,
  setConnecting,
  setRunning,
  setSessionListError,
  setSessionListLoaded,
  statusBadgeText,
  statusCssClass,
  type SessionStatusState
} from "./lib/sessionStatus";

type ThemePreference = "light" | "dark" | "system";
type SessionRuntimeMetadata = {
  provider: string;
  model: string;
};

let systemThemeQuery: MediaQueryList | null = null;
const piSessions = ref<PiSessionSummary[]>([]);
const activeSessionId = ref<string | null>(null);
const draftSessionPath = ref<string | null>(null);
const draftTitle = ref("New chat");
const session = reactive<SessionState>(createInitialSessionState());
const sessionView = reactive<SessionView>(createEmptySessionView());
const sessionStatus = reactive<SessionStatusState>(createInitialSessionStatus());
const prompt = ref("");
const queueMode = ref<"steer" | "follow_up">("steer");
const stderr = ref<string[]>([]);
const extensionValue = ref("");
const sidebarCollapsed = ref(false);
const showNonMessageResponses = ref(readNonMessageResponsePreference());
const themePreference = ref<ThemePreference>(readThemePreference());
const messageScroller = ref<HTMLElement | null>(null);
const isSessionLoading = ref(false);
const isSending = ref(false);
const metadataOpen = ref(false);
const metadataDialog = ref<HTMLElement | null>(null);
const sessionDetailsButton = ref<HTMLButtonElement | null>(null);
const sessionRuntime = reactive<SessionRuntimeMetadata>({ provider: "", model: "" });

const sessionManager = getSessionManager();
let listUnsubscribe: Unsubscribe | null = null;
let currentSessionUnsubscribe: Unsubscribe | null = null;

const activePiSession = computed(() => piSessions.value.find((item) => item.id === activeSessionId.value));
const activeTitle = computed(() => activePiSession.value?.title ?? draftTitle.value);
const canSend = computed(() => prompt.value.trim().length > 0);
const pendingExtension = computed(() => session.extensionRequests[0]);
const extensionOptions = computed(() => {
  const options = pendingExtension.value?.params.options;
  return Array.isArray(options) ? options.map(String) : [];
});
const extensionTitle = computed(() => stringParam("title") || pendingExtension.value?.method || "Extension request");
const extensionMessage = computed(() => stringParam("message") || stringParam("label"));
const extensionUsesEditor = computed(() => pendingExtension.value?.method === "input" || pendingExtension.value?.method === "editor");
const connectionLabelText = computed(() => connectionLabel(sessionStatus));
const statusBadgeTextComputed = computed(() => statusBadgeText(sessionStatus));
const statusClass = computed(() => statusCssClass(sessionStatus));
const themeIcon = computed(() => ({ light: Sun, dark: Moon, system: Monitor })[themePreference.value]);
const sidebarIcon = computed(() => (sidebarCollapsed.value ? PanelLeftOpen : PanelLeftClose));
const nonMessageResponseIcon = computed(() => (showNonMessageResponses.value ? Eye : EyeOff));
const themeTitle = computed(() => `Theme: ${themePreference.value}`);
const nonMessageResponseTitle = computed(() =>
  showNonMessageResponses.value ? "Hide thinking and tool calls" : "Show thinking and tool calls"
);
const sessionError = computed(() =>
  sessionStatus.displayStatus === "failed" ? sessionStatus.errorMessage || sessionStatus.statusText : ""
);
const toolActivitySignature = computed(() =>
  session.messages
    .map((message) => message.tools.map((tool) => `${tool.key}:${tool.status}:${tool.content.length}`).join("|"))
    .join(";")
);
const sessionMetadataRows = computed(() => {
  const rows = [
    { label: "Connection", value: connectionLabelText.value },
    { label: "Session", value: activeTitle.value },
    { label: "State", value: session.statusText },
    { label: "Messages", value: String(session.messages.length) }
  ];

  if (activeSessionId.value) {
    rows.push({ label: "Session ID", value: activeSessionId.value });
  }
  if (sessionRuntime.provider) {
    rows.push({ label: "Provider", value: sessionRuntime.provider });
  }
  if (sessionRuntime.model) {
    rows.push({ label: "Model", value: sessionRuntime.model });
  }
  if (activePiSession.value?.path) {
    rows.push({ label: "File", value: activePiSession.value.path });
  }
  if (activePiSession.value?.modified) {
    rows.push({ label: "Modified", value: activePiSession.value.modified });
  }
  if (session.tools.length) {
    rows.push({ label: "Tool runs", value: String(session.tools.length) });
  }
  if (session.queue.length) {
    rows.push({ label: "Queued", value: String(session.queue.length) });
  }

  return rows;
});

watch(pendingExtension, (request) => {
  if (!request) {
    extensionValue.value = "";
    return;
  }

  extensionValue.value = stringParam("prefill") || stringParam("text") || extensionOptions.value[0] || "";
});

watch(
  () => [activeSessionId.value, session.messages.length, toolActivitySignature.value],
  () => {
    void scrollMessagesToEnd();
  },
  { flush: "post" }
);

watch(themePreference, (value) => {
  localStorage.setItem("agent-web-theme", value);
  applyTheme();
});

watch(showNonMessageResponses, (value) => {
  localStorage.setItem("agent-web-show-non-message-responses", value ? "true" : "false");
});

watch(metadataOpen, async (open) => {
  if (!open) return;

  await nextTick();
  metadataDialog.value?.focus();
});

// Prefill the prompt input when a set_editor_text extension draft arrives
// via a ViewPatch (routed through piStreamEventToPatch).
watch(
  () => sessionView.extensionDraft,
  (text) => {
    if (text) {
      prompt.value = text;
    }
  },
);

onMounted(() => {
  systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemThemeQuery.addEventListener("change", applyTheme);
  applyTheme();

  void sessionManager.listSessions().then((sessions) => {
    piSessions.value = sessions.map(toPiSessionSummary);
    Object.assign(sessionStatus, setSessionListLoaded(sessionStatus));
    session.statusText = "Ready";
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    Object.assign(sessionStatus, setSessionListError(sessionStatus, message));
    session.statusText = `Failed to list sessions: ${message}`;
  });

  listUnsubscribe = sessionManager.subscribeToSessionList((sessions) => {
    piSessions.value = sessions.map(toPiSessionSummary);
  });
});

onBeforeUnmount(() => {
  systemThemeQuery?.removeEventListener("change", applyTheme);
  listUnsubscribe?.();
  currentSessionUnsubscribe?.();
});

function newChat() {
  currentSessionUnsubscribe?.();
  currentSessionUnsubscribe = null;
  isSessionLoading.value = false;
  activeSessionId.value = null;
  draftSessionPath.value = null;
  draftTitle.value = "New chat";
  prompt.value = "";
  clearSessionRuntime();
  hydrateSessionMessages(session, []);
  session.statusText = "Ready for new chat";
  Object.assign(sessionView, createEmptySessionView());
  Object.assign(sessionStatus, setConnected(sessionStatus, "Ready for new chat"));
}

async function selectChat(id: string) {
  const item = piSessions.value.find((candidate) => candidate.id === id);
  if (!item) return;

  currentSessionUnsubscribe?.();
  currentSessionUnsubscribe = null;

  activeSessionId.value = id;
  draftSessionPath.value = null;
  draftTitle.value = item.title;
  prompt.value = "";
  isSessionLoading.value = true;
  clearSessionRuntime();
  hydrateSessionMessages(session, []);
  session.statusText = "Opening session";
  Object.assign(sessionStatus, setConnecting(sessionStatus, "Opening session"));

  const requestedId = id;
  try {
    // Buffer live events until the snapshot is applied so a live event
    // that arrives before hydrateSessionMessages() can't be overwritten.
    const pending: StreamEvent[] = [];
    let hydrated = false;

    const { snapshot, unsubscribe } = await sessionManager.openAndSubscribeSession(
      requestedId,
      (streamEvent) => {
        if (!hydrated) {
          pending.push(streamEvent);
        } else {
          handleStreamEvent(streamEvent);
        }
      },
    );

    // If the user selected another chat while we were opening, bail.
    if (activeSessionId.value !== requestedId) {
      unsubscribe();
      return;
    }

    currentSessionUnsubscribe = unsubscribe;

    // Apply the full snapshot first so pending live events see a
    // properly initialized state when piStreamEventToPatch references
    // sessionView for context-dependent transitions.
    Object.assign(sessionView, snapshot.view);
    hydrateSessionFromView(session, snapshot.view);

    // Derive display status from the snapshot's backend status so we
    // don't lose stronger states (running, blocked, failed, stopped)
    // when opening an active session.
    Object.assign(sessionStatus, reduceSessionStatusEvent(sessionStatus, {
      type: "session.updated",
      eventId: "",
      sessionId: requestedId,
      createdAt: new Date().toISOString(),
      payload: { session: snapshot.session },
    }));

    // Fall back to connected only when no stronger status was derived
    // (i.e. the snapshot was idle and no pending events upgraded it).
    if (sessionStatus.displayStatus === "connecting") {
      Object.assign(sessionStatus, setConnected(sessionStatus));
    }

    // Replay any pending live events on top of the initialized snapshot.
    hydrated = true;
    for (const event of pending) {
      handleStreamEvent(event);
    }

    session.statusText = snapshot.view.items.length ? "Session loaded" : "No messages yet";
    isSessionLoading.value = false;

    if (snapshot.state) {
      applySessionRuntime(snapshot.state);
      const sessionName = typeof snapshot.state.sessionName === "string" ? snapshot.state.sessionName : "";
      if (sessionName && !activePiSession.value) {
        draftTitle.value = sessionName;
      }
    }
  } catch (error) {
    // If the user selected another chat, don't show a stale error.
    if (activeSessionId.value !== requestedId) return;
    isSessionLoading.value = false;
    Object.assign(sessionStatus, reduceSessionStatusEvent(sessionStatus, {
      type: "error",
      eventId: "",
      createdAt: new Date().toISOString(),
      payload: { message: error instanceof Error ? error.message : String(error) },
    }));
    session.statusText = `Pi request failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function openMetadata() {
  metadataOpen.value = true;
}

async function closeMetadata() {
  metadataOpen.value = false;
  await nextTick();
  sessionDetailsButton.value?.focus();
}

function trapMetadataFocus(event: KeyboardEvent) {
  const dialog = metadataDialog.value;
  if (!dialog) return;

  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");

  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (document.activeElement === dialog) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function cycleTheme() {
  const themes: ThemePreference[] = ["light", "dark", "system"];
  const currentIndex = themes.indexOf(themePreference.value);
  themePreference.value = themes[(currentIndex + 1) % themes.length];
}

async function sendPrompt() {
  const message = prompt.value.trim();
  if (!message || isSending.value) return;

  isSending.value = true;
  prompt.value = "";
  appendLocalUserMessage(session, message);
  if (!activeSessionId.value && draftTitle.value === "New chat") {
    draftTitle.value = titleFromPrompt(message);
  }

  try {
    let sessionId = activeSessionId.value;
    if (!sessionId) {
      const draft = await sessionManager.createSession({});
      sessionId = draft.id;
      activeSessionId.value = sessionId;
      currentSessionUnsubscribe?.();
      currentSessionUnsubscribe = sessionManager.subscribeToSession(sessionId, (streamEvent) => {
        handleStreamEvent(streamEvent);
      });
      session.statusText = "Starting Pi";
      Object.assign(sessionStatus, setRunning(sessionStatus, "Starting Pi"));
    }

    await sessionManager.sendMessage(sessionId, message, {
      mode: sessionManagerMode(queueMode.value),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send message";
    Object.assign(sessionStatus, reduceSessionStatusEvent(sessionStatus, {
      type: "error",
      eventId: "",
      createdAt: new Date().toISOString(),
      payload: { message },
    }));
    session.statusText = message;
  } finally {
    isSending.value = false;
  }
}

async function respondToExtension(request: ExtensionRequest, accepted: boolean) {
  const sessionId = activeSessionId.value;
  if (sessionId) {
    try {
      await sessionManager.respondToUserRequest(sessionId, {
        id: request.id,
        cancelled: !accepted,
        confirmed: accepted && request.method === "confirm",
        value: accepted && request.method !== "confirm" ? extensionValue.value : undefined,
      });
    } catch (error) {
      session.statusText = `Extension response failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  acknowledgeExtensionRequest(session, request.id);
  // Also clear the pending request from the SessionView so the status
  // resolves correctly.
  Object.assign(sessionView, applyViewPatch(sessionView, { type: "clearPendingRequest", id: request.id }));
  if (sessionView.pendingRequests.length === 0) {
    Object.assign(sessionStatus, {
      ...sessionStatus,
      displayStatus:
        sessionStatus.displayStatus === "blocked"
          ? sessionView.status === "running"
            ? "running"
            : "connected"
          : sessionStatus.displayStatus,
    });
  }
  extensionValue.value = "";
}

function stringParam(key: string): string {
  const value = pendingExtension.value?.params[key];
  return typeof value === "string" ? value : "";
}

function sessionManagerMode(mode: "steer" | "follow_up"): "steer" | "followUp" {
  return mode === "follow_up" ? "followUp" : "steer";
}

function toPiSessionSummary(s: SessionSummary): PiSessionSummary {
  const metadata = s.metadata as Record<string, unknown> | undefined;
  return {
    id: s.id,
    path: s.sessionPath ?? "",
    cwd: typeof metadata?.cwd === "string" ? metadata.cwd : undefined,
    title: s.title,
    created: s.createdAt,
    modified: s.updatedAt,
    messageCount: typeof metadata?.messageCount === "number" ? metadata.messageCount : undefined,
    firstMessage: typeof metadata?.firstMessage === "string" ? metadata.firstMessage : undefined,
  };
}

function handleStreamEvent(event: StreamEvent): void {
  switch (event.type) {
    case "session.updated":
      Object.assign(sessionStatus, reduceSessionStatusEvent(sessionStatus, event));
      break;
    case "pi.event": {
      const piEvent = event.payload.event as Record<string, unknown> | undefined;
      if (piEvent) {
        // Route through the protocol adapter to get a ViewPatch, then
        // apply it to both the SessionView (source of truth) and the
        // SessionState (template model).
        const patch = piStreamEventToPatch(piEvent, sessionView);
        if (patch) {
          Object.assign(sessionView, applyViewPatch(sessionView, patch));
          reduceSessionViewPatch(session, patch);
          // Drive status from all ViewPatch types that affect it.
          if (patch.type === "setStatus") {
            Object.assign(sessionStatus, reduceSessionStatusFromPatch(sessionStatus, patch));
          } else if (patch.type === "setPendingRequest") {
            // applyViewPatch already set sessionView.status = "blocked".
            // Reflect that in the sessionStatus model so the pill updates.
            Object.assign(sessionStatus, {
              ...sessionStatus,
              displayStatus: "blocked",
              connected: true,
              statusText: "Waiting for input",
            });
          } else if (patch.type === "clearPendingRequest") {
            // applyViewPatch already cleared the request and may have
            // restored sessionView.status.  Sync sessionStatus to match.
            if (sessionView.pendingRequests.length === 0) {
              Object.assign(sessionStatus, {
                ...sessionStatus,
                displayStatus:
                  sessionStatus.displayStatus === "blocked"
                    ? sessionView.status === "running"
                      ? "running"
                      : "connected"
                    : sessionStatus.displayStatus,
              });
            }
          }
        }
      }
      break;
    }
    case "pi.response": {
      const piResponse = event.payload.response as Record<string, unknown> | undefined;
      if (piResponse) {
        applyPiResponse(piResponse);
      }
      break;
    }
    case "pi.status": {
      Object.assign(sessionStatus, reduceSessionStatusEvent(sessionStatus, event));
      const piStatus = (event.payload.status as string) ?? "";
      if (piStatus === "exited") {
        isSessionLoading.value = false;
      }
      break;
    }
    case "pi.stderr": {
      const data = typeof event.payload.data === "string" ? event.payload.data : "";
      stderr.value.unshift(data);
      stderr.value = stderr.value.slice(0, 20);
      break;
    }
    case "user_request.created": {
      Object.assign(sessionStatus, reduceSessionStatusEvent(sessionStatus, event));
      const request = event.payload.request as Record<string, unknown> | undefined;
      if (request) {
        prefillEditorPrompt(request);
        reduceSessionEvent(session, request);
      }
      break;
    }
    case "error": {
      Object.assign(sessionStatus, reduceSessionStatusEvent(sessionStatus, event));
      isSessionLoading.value = false;
      break;
    }
  }
}


function applyPiResponse(response: Record<string, unknown>) {
  if (response.success !== false && response.command === "get_state") {
    const data = typeof response.data === "object" && response.data !== null ? (response.data as Record<string, unknown>) : {};
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
    const sessionName = typeof data.sessionName === "string" ? data.sessionName : "";
    if (sessionId && !activeSessionId.value) {
      activeSessionId.value = sessionId;
    }
    if (sessionName && !activePiSession.value) {
      draftTitle.value = sessionName;
    }
    applySessionRuntime(data);
  }

  reduceSessionResponse(session, response);
}

function clearSessionRuntime() {
  sessionRuntime.provider = "";
  sessionRuntime.model = "";
}

function applySessionRuntime(data: Record<string, unknown>) {
  const model = objectField(data.model);
  const modelApi = objectField(model?.api);
  const provider = firstDisplayValue(data.provider, model?.provider, model?.api, modelApi?.provider);
  const modelName = firstDisplayValue(data.model, model?.name, model?.id);

  sessionRuntime.provider = provider;
  sessionRuntime.model = modelName;
}

function firstDisplayValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized && !looksLikeUuid(normalized)) {
        return normalized;
      }
      continue;
    }

    const object = objectField(value);
    if (object) {
      const nested = firstDisplayValue(object.name, object.displayName, object.label, object.id);
      if (nested) {
        return nested;
      }
    }
  }

  return "";
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value) {
      return value;
    }
  }

  return "";
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

function sessionPrompt(item: PiSessionSummary): string {
  return (item.firstMessage || item.title).replace(/\s+/g, " ").trim() || "Untitled session";
}

function formatSessionTimestamp(item: PiSessionSummary): string {
  const timestamp = item.modified || item.created;
  if (!timestamp) return "";

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const time = `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) {
    return time;
  }

  const dayAndMonth = `${date.getDate()} ${shortMonthName(date.getMonth())}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${dayAndMonth} ${time}`;
  }

  return `${dayAndMonth} ${date.getFullYear()} ${time}`;
}

function padTimePart(value: number): string {
  return String(value).padStart(2, "0");
}

function shortMonthName(month: number): string {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month] ?? "";
}

function readThemePreference(): ThemePreference {
  const stored = localStorage.getItem("agent-web-theme");
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function readNonMessageResponsePreference(): boolean {
  return localStorage.getItem("agent-web-show-non-message-responses") !== "false";
}

function shouldShowMessage(message: SessionMessage): boolean {
  return (
    showNonMessageResponses.value ||
    Boolean(message.content) ||
    shouldShowMessageShimmer(message) ||
    (!message.thinking && message.tools.length === 0)
  );
}

function shouldShowMessageShimmer(message: SessionMessage): boolean {
  return message.role === "assistant" && message.status === "streaming" && !message.content;
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
          :aria-label="`Chat session: ${sessionPrompt(item)}`"
          :aria-current="item.id === activeSessionId ? 'page' : undefined"
          @click="selectChat(item.id)"
        >
          <span class="session-prompt" :title="sessionPrompt(item)">{{ sessionPrompt(item) }}</span>
          <span class="session-date">{{ formatSessionTimestamp(item) }}</span>
        </button>
        <p v-if="piSessions.length === 0" class="session-empty">No saved sessions</p>
      </nav>

      <div class="profile-row">
        <div class="avatar">U</div>
        <div class="profile-copy">
          <strong>User</strong>
        </div>
      </div>
    </aside>

    <section class="main-chat">
      <header class="chat-header">
        <button class="icon-button" type="button" aria-label="Toggle sidebar" title="Toggle sidebar" @click="sidebarCollapsed = !sidebarCollapsed">
          <component :is="sidebarIcon" :size="19" aria-hidden="true" />
        </button>
        <h1>{{ activeTitle }}</h1>
        <div class="status-actions">
          <span class="status-pill" :class="statusClass">{{ statusBadgeTextComputed }}</span>
          <button
            class="icon-button"
            type="button"
            :aria-label="nonMessageResponseTitle"
            :title="nonMessageResponseTitle"
            :aria-pressed="showNonMessageResponses"
            @click="showNonMessageResponses = !showNonMessageResponses"
          >
            <component :is="nonMessageResponseIcon" :size="18" aria-hidden="true" />
          </button>
          <button ref="sessionDetailsButton" class="icon-button" type="button" aria-label="Session details" title="Session details" @click="openMetadata">
            <Info :size="18" aria-hidden="true" />
          </button>
        </div>
      </header>

      <Conversation>
        <div ref="messageScroller" class="conversation-scroll">
          <div v-if="isSessionLoading" class="welcome loading-state" role="status" aria-live="polite">
            <span class="loading-spinner" aria-hidden="true"></span>
            <h2>Loading session</h2>
            <p>Opening saved chat...</p>
          </div>

          <div v-else-if="sessionError" class="welcome error-state" role="alert">
            <h2>Could not load session</h2>
            <p>{{ sessionError }}</p>
          </div>

          <div v-else-if="session.messages.length === 0" class="welcome">
            <h2>Start a chat with Pi</h2>
            <p>Send a prompt or open a saved session.</p>
          </div>

          <div class="message-stack">
            <template v-for="message in session.messages" :key="message.id">
              <Message
                v-if="shouldShowMessage(message)"
                :role="message.role"
                :streaming="message.status === 'streaming'"
                :copy-text="message.content || undefined"
              >
                <details v-if="showNonMessageResponses && message.thinking" class="thinking">
                  <summary>Thinking</summary>
                  <pre>{{ message.thinking }}</pre>
                </details>
                <details v-for="tool in showNonMessageResponses ? message.tools : []" :key="`${message.id}-${tool.key}`" class="thinking tool-detail">
                  <summary>
                    <span class="tool-summary-text">
                      <span class="tool-summary-name">{{ tool.label }}</span>
                      <span v-if="tool.detail" class="tool-summary-detail">{{ tool.detail }}</span>
                      <span v-if="tool.statusLabel" class="visually-hidden">, {{ tool.statusLabel }}</span>
                    </span>
                    <span
                      v-if="tool.status"
                      class="tool-status-dot"
                      :class="`tool-status-dot-${tool.status}`"
                      :title="tool.statusLabel"
                      aria-hidden="true"
                    ></span>
                  </summary>
                  <pre>{{ tool.content }}</pre>
                </details>
                <div v-if="message.content" class="message-markdown" v-html="renderMarkdown(message.content)"></div>
                <Shimmer v-else-if="shouldShowMessageShimmer(message)" />
                <div v-else-if="!message.thinking && message.tools.length === 0" class="message-markdown"></div>
              </Message>
            </template>

            <details v-if="showNonMessageResponses && session.queue.length" class="inline-activity">
              <summary>{{ session.queue.length }} queued command{{ session.queue.length === 1 ? "" : "s" }}</summary>
              <ol class="compact-list">
                <li v-for="item in session.queue" :key="String(item.id ?? item.command)">
                  {{ item.label ?? item.command ?? "queued" }}
                </li>
              </ol>
            </details>

            <details v-if="showNonMessageResponses && stderr.length" class="inline-activity error-row">
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

    <div v-if="metadataOpen" class="modal-backdrop" @click.self="closeMetadata">
      <section
        ref="metadataDialog"
        class="modal metadata-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="metadata-title"
        tabindex="-1"
        @keydown.esc.stop="closeMetadata"
        @keydown.tab="trapMetadataFocus"
      >
        <div class="modal-heading">
          <h2 id="metadata-title">Session details</h2>
          <button class="icon-button" type="button" aria-label="Close session details" title="Close" @click="closeMetadata">
            <X :size="18" aria-hidden="true" />
          </button>
        </div>
        <dl class="metadata-list">
          <template v-for="row in sessionMetadataRows" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </template>
        </dl>
      </section>
    </div>

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
