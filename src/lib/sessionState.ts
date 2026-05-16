export type Role = "user" | "assistant" | "system";
export type MessageStatus = "streaming" | "done";

export type SessionMessage = {
  id: string;
  role: Role;
  content: string;
  thinking: string;
  toolDeltas: string[];
  status: MessageStatus;
};

export type ToolExecution = {
  id: string;
  name: string;
  status: "running" | "done" | "failed";
  input?: unknown;
  output?: unknown;
  log: string[];
};

export type QueueItem = {
  id?: string;
  command?: string;
  label?: string;
  [key: string]: unknown;
};

export type ExtensionRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

export type ActivityItem = {
  id: string;
  type: string;
  summary: string;
  time: string;
  raw: unknown;
};

export type SessionState = {
  connected: boolean;
  running: boolean;
  turnActive: boolean;
  autoRetry: boolean;
  autoCompaction: boolean;
  messages: SessionMessage[];
  tools: ToolExecution[];
  queue: QueueItem[];
  activity: ActivityItem[];
  extensionRequests: ExtensionRequest[];
  statusText: string;
  activeMessageId: string | null;
};

export type PiEvent = {
  type?: string;
  [key: string]: unknown;
};

export type PiResponse = {
  type?: "response";
  id?: string;
  success?: boolean;
  command?: string;
  data?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

let generatedId = 0;

export function createInitialSessionState(): SessionState {
  return {
    connected: false,
    running: false,
    turnActive: false,
    autoRetry: true,
    autoCompaction: true,
    messages: [],
    tools: [],
    queue: [],
    activity: [],
    extensionRequests: [],
    statusText: "Disconnected",
    activeMessageId: null
  };
}

export function reduceSessionEvent(state: SessionState, event: PiEvent): SessionState {
  const type = String(event.type ?? "unknown");
  addActivity(state, event, summarizeEvent(event));

  if (isPiUserMessageEvent(type, event)) {
    return state;
  }

  switch (type) {
    case "agent_start":
      state.running = true;
      state.statusText = "Agent running";
      break;
    case "agent_end":
      state.running = false;
      state.turnActive = false;
      state.statusText = "Agent finished";
      break;
    case "turn_start":
      state.turnActive = true;
      break;
    case "turn_end":
      state.turnActive = false;
      break;
    case "message_start":
      state.activeMessageId = resolveMessageId(state, event);
      applyCompleteMessage(upsertMessage(state, state.activeMessageId, roleFromEvent(event), "streaming"), event);
      break;
    case "message_update":
      applyMessageUpdate(state, event);
      break;
    case "message_end":
      applyCompleteMessage(upsertMessage(state, resolveMessageId(state, event), roleFromEvent(event), "done"), event);
      state.activeMessageId = null;
      break;
    case "tool_execution_start":
      state.tools.push({
        id: toolId(event),
        name: stringField(event.name) || stringField(event.toolName) || "tool",
        status: "running",
        input: event.input ?? event.args,
        log: []
      });
      break;
    case "tool_execution_update":
      updateTool(state, toolId(event), (tool) => {
        const partial = textFromContent(event.partialResult) || stringField(event.delta) || stringField(event.output) || stringField(event.message);
        if (partial) {
          tool.log = [partial];
        }
      });
      break;
    case "tool_execution_end":
      updateTool(state, toolId(event), (tool) => {
        tool.status = event.success === false || event.isError === true ? "failed" : "done";
        tool.output = event.output ?? event.result;
      });
      break;
    case "queue_update":
      state.queue = queueItems(event);
      break;
    case "compaction_start":
      state.statusText = "Compacting session";
      break;
    case "compaction_end":
      state.statusText = "Compaction complete";
      break;
    case "auto_retry_start":
      state.statusText = "Auto retry running";
      break;
    case "auto_retry_end":
      state.statusText = "Auto retry finished";
      break;
    case "extension_ui_request":
      addExtensionRequest(state, event);
      break;
    case "extension_error":
      state.statusText = stringField(event.message) || "Extension error";
      break;
  }

  return state;
}

export function reduceSessionResponse(state: SessionState, response: PiResponse): SessionState {
  addActivity(state, response, summarizeResponse(response));

  if (response.success === false || response.error) {
    state.statusText = `Pi request failed: ${responseErrorText(response.error)}`;
    return state;
  }

  const payload = response.data ?? response.result;
  if (payload) {
    state.statusText = summarizeResult(payload);
  } else {
    state.statusText = "Pi request completed";
  }

  return state;
}

export function acknowledgeExtensionRequest(state: SessionState, id: string): void {
  state.extensionRequests = state.extensionRequests.filter((request) => request.id !== id);
}

export function hydrateSessionMessages(state: SessionState, piMessages: unknown[]): SessionState {
  state.messages = piMessages.map((message, index) => hydrateSessionMessage(message, index));
  state.tools = [];
  state.queue = [];
  state.extensionRequests = [];
  state.activity = [];
  state.activeMessageId = null;
  state.turnActive = false;
  state.running = false;
  state.statusText = state.messages.length ? "Session loaded" : "No messages yet";
  return state;
}

export function appendLocalUserMessage(state: SessionState, content: string): SessionMessage {
  const message: SessionMessage = {
    id: createId("local-user"),
    role: "user",
    content,
    thinking: "",
    toolDeltas: [],
    status: "done"
  };
  state.messages.push(message);
  return message;
}

function hydrateSessionMessage(value: unknown, index: number): SessionMessage {
  const message = objectField(value);
  const role = roleFromHydratedMessage(message);
  const extracted = extractHydratedContent(message?.content);

  return {
    id: stringField(message?.id) || numberField(message?.timestamp) || `pi-message-${index + 1}`,
    role,
    content: extracted.content,
    thinking: extracted.thinking,
    toolDeltas: extracted.toolDeltas,
    status: "done"
  };
}

function roleFromHydratedMessage(message: Record<string, unknown> | undefined): Role {
  const role = stringField(message?.role);
  return role === "user" || role === "system" ? role : "assistant";
}

function extractHydratedContent(content: unknown): Pick<SessionMessage, "content" | "thinking" | "toolDeltas"> {
  if (typeof content === "string") {
    return { content, thinking: "", toolDeltas: [] };
  }

  if (!Array.isArray(content)) {
    return { content: "", thinking: "", toolDeltas: [] };
  }

  const text: string[] = [];
  const thinking: string[] = [];
  const toolDeltas: string[] = [];

  for (const part of content) {
    const item = objectField(part);
    if (!item) {
      continue;
    }

    const textValue = stringField(item.text);
    if (textValue) {
      text.push(textValue);
      continue;
    }

    const thinkingValue = stringField(item.thinking);
    if (thinkingValue) {
      thinking.push(thinkingValue);
      continue;
    }

    toolDeltas.push(JSON.stringify(item));
  }

  return { content: text.join(""), thinking: thinking.join(""), toolDeltas };
}

function applyMessageUpdate(state: SessionState, event: PiEvent): void {
  const id = resolveMessageId(state, event);
  state.activeMessageId = id;
  const message = upsertMessage(state, id, roleFromEvent(event), "streaming");
  const assistantEvent = event.assistantMessageEvent as PiEvent | undefined;
  const deltaType = assistantEvent?.type;

  if (deltaType === "text_delta") {
    message.content += stringField(assistantEvent?.delta);
    return;
  }

  if (deltaType === "thinking_delta") {
    message.thinking += stringField(assistantEvent?.delta);
    return;
  }

  if (deltaType) {
    message.toolDeltas.push(JSON.stringify(assistantEvent));
  } else if (event.delta) {
    message.content += stringField(event.delta);
  }
}

function upsertMessage(state: SessionState, id: string, role: Role, status: MessageStatus): SessionMessage {
  const existing = state.messages.find((message) => message.id === id);
  if (existing) {
    existing.status = status;
    return existing;
  }

  const message: SessionMessage = {
    id,
    role,
    content: "",
    thinking: "",
    toolDeltas: [],
    status
  };
  state.messages.push(message);
  return message;
}

function updateTool(state: SessionState, id: string, update: (tool: ToolExecution) => void): void {
  const tool = state.tools.find((item) => item.id === id);
  if (tool) {
    update(tool);
  }
}

function addExtensionRequest(state: SessionState, event: PiEvent): void {
  const id = stringField(event.id) || createId("extension");
  const method = stringField(event.method) || "notify";
  const params = extensionParams(event);

  if (isFireAndForgetExtensionMethod(method)) {
    if (method === "set_editor_text") {
      state.statusText = "Editor text updated";
      return;
    }

    state.statusText =
      stringField(params?.statusText) ||
      stringField(params?.message) ||
      stringField(params?.status) ||
      stringField(params?.title) ||
      method;
    return;
  }

  state.extensionRequests.push({ id, method, params });
}

function extensionParams(event: PiEvent): Record<string, unknown> {
  if (typeof event.params === "object" && event.params !== null) {
    return event.params as Record<string, unknown>;
  }

  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key !== "type" && key !== "id" && key !== "method") {
      params[key] = value;
    }
  }
  return params;
}

function addActivity(state: SessionState, event: PiEvent, summary: string): void {
  state.activity.unshift({
    id: createId("activity"),
    type: String(event.type ?? "unknown"),
    summary,
    time: new Date().toLocaleTimeString(),
    raw: event
  });
  state.activity = state.activity.slice(0, 80);
}

function createId(prefix: string): string {
  generatedId += 1;
  return `${prefix}-${Date.now()}-${generatedId}`;
}

function summarizeEvent(event: PiEvent): string {
  const type = String(event.type ?? "unknown");
  if (type === "message_update") {
    return "Assistant message updated";
  }
  if (type === "tool_execution_start") {
    return `Started ${stringField(event.name) || "tool"}`;
  }
  if (type === "extension_ui_request") {
    return `Extension requested ${stringField(event.method) || "UI"}`;
  }
  return type.replaceAll("_", " ");
}

function summarizeResponse(response: PiResponse): string {
  if (response.success === false || response.error) {
    return `Pi response failed: ${responseErrorText(response.error)}`;
  }

  return "Pi response received";
}

function summarizeResult(result: unknown): string {
  const object = objectField(result);
  if (!object) {
    return "Pi request completed";
  }

  const sessionId = stringField(object.sessionId) || stringField(object.session_id) || stringField(object.id);
  const model = stringField(object.model);
  const provider = stringField(object.provider);
  const status = stringField(object.status) || stringField(object.state);
  const runtime = [provider, model].filter(Boolean).join("/");
  const readableStatus = status ? status.replaceAll("_", " ") : "";

  if (readableStatus && runtime) {
    return `Pi ${readableStatus} (${runtime})`;
  }

  if (readableStatus) {
    return `Pi ${readableStatus}`;
  }

  if (runtime) {
    return `Pi configured (${runtime})`;
  }

  if (sessionId) {
    return "Session ready";
  }

  return "Pi request completed";
}

function responseErrorText(error: unknown): string {
  if (!error) {
    return "unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  const object = objectField(error);
  return stringField(object?.message) || JSON.stringify(error);
}

function isFireAndForgetExtensionMethod(method: string): boolean {
  return ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(method);
}

function resolveMessageId(state: SessionState, event: PiEvent): string {
  return messageId(event) || state.activeMessageId || `message-${state.messages.length + 1}`;
}

function messageId(event: PiEvent): string {
  const message = objectField(event.message);
  return (
    stringField(event.messageId) ||
    stringField(event.id) ||
    stringField(message?.id) ||
    stringField(message?.timestamp)
  );
}

function toolId(event: PiEvent): string {
  return stringField(event.id) || stringField(event.toolExecutionId) || stringField(event.toolCallId) || `tool-${Date.now()}`;
}

function roleFromEvent(event: PiEvent): Role {
  const message = objectField(event.message);
  const role = stringField(event.role) || stringField(message?.role);
  return role === "user" || role === "system" ? role : "assistant";
}

function isPiUserMessageEvent(type: string, event: PiEvent): boolean {
  return type.startsWith("message_") && roleFromEvent(event) === "user";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): string {
  return typeof value === "number" ? String(value) : "";
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function applyCompleteMessage(message: SessionMessage, event: PiEvent): void {
  const eventMessage = objectField(event.message);
  const content = eventMessage?.content;
  if (!content || message.content) {
    return;
  }

  if (typeof content === "string") {
    message.content = content;
    return;
  }

  if (Array.isArray(content)) {
    message.content = content
      .map((part) => {
        const item = objectField(part);
        return stringField(item?.text);
      })
      .filter(Boolean)
      .join("");
  }
}

function queueItems(event: PiEvent): QueueItem[] {
  if (Array.isArray(event.items)) {
    return event.items as QueueItem[];
  }

  const items: QueueItem[] = [];
  for (const command of ["steering", "followUp"]) {
    const values = event[command];
    if (!Array.isArray(values)) {
      continue;
    }

    values.forEach((value, index) => {
      items.push({
        id: `${command}-${index}`,
        command: command === "steering" ? "steer" : "follow_up",
        label: typeof value === "string" ? value : JSON.stringify(value),
        value
      });
    });
  }
  return items;
}

function textFromContent(value: unknown): string {
  const object = objectField(value);
  const content = object?.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      const item = objectField(part);
      return stringField(item?.text);
    })
    .filter(Boolean)
    .join("");
}
