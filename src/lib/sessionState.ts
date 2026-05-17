export type Role = "user" | "assistant" | "system";
export type MessageStatus = "streaming" | "done";
export type MessageToolStatus = "running" | "done" | "error";

export type MessageToolPart = {
  type: "tool";
  key: string;
  id?: string;
  label: string;
  name: string;
  detail?: string;
  status: MessageToolStatus;
  statusLabel: string;
  content: string;
  input?: unknown;
  output?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
};

export type SessionMessage = {
  id: string;
  role: Role;
  content: string;
  thinking: string;
  tools: MessageToolPart[];
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
  sessionPath?: string;
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
      applyCompleteMessage(upsertMessageForStart(state, state.activeMessageId, roleFromEvent(event), "streaming"), event);
      break;
    case "message_update":
      applyMessageUpdate(state, event);
      break;
    case "message_end":
      applyCompleteMessage(upsertMessage(state, resolveMessageId(state, event), roleFromEvent(event), "done"), event);
      state.activeMessageId = null;
      break;
    case "tool_execution_start":
      upsertExecutionTool(state, event, (tool) => {
        tool.name = toolName(event) || tool.name;
        tool.status = "running";
        tool.input = toolInput(event);
      });
      upsertMessageToolPart(state, event, { status: "running" });
      break;
    case "tool_execution_update":
      updateTool(state, toolId(event), (tool) => {
        const partial = textFromContent(event.partialResult) || stringField(event.delta) || stringField(event.output) || stringField(event.message);
        if (partial) {
          tool.log = [partial];
        }
      });
      upsertMessageToolPart(state, event, { status: "running" });
      break;
    case "tool_execution_end":
      updateTool(state, toolId(event), (tool) => {
        tool.status = isToolError(event) ? "failed" : "done";
        tool.output = event.output ?? event.result;
      });
      upsertMessageToolPart(state, event, { status: isToolError(event) ? "error" : "done" });
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
  state.messages = [];
  piMessages.forEach((message, index) => hydrateSessionMessageIntoState(state, message, index));
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
    tools: [],
    status: "done"
  };
  state.messages.push(message);
  return message;
}

function hydrateSessionMessageIntoState(state: SessionState, value: unknown, index: number): void {
  const message = objectField(value);
  const role = roleFromHydratedMessage(message);
  const extracted = extractHydratedContent(message?.content);
  if (isHydratedToolResult(message)) {
    const toolResult = message as Record<string, unknown>;
    const target = assistantMessageForToolPart(state, toolPartKey(toolResult));
    mergeToolPart(target, toolPartFromHydratedToolResult(toolResult));
    target.status = "done";
    return;
  }

  state.messages.push({
    id: stringField(message?.id) || numberField(message?.timestamp) || `pi-message-${index + 1}`,
    role,
    content: extracted.content,
    thinking: extracted.thinking,
    tools: extracted.tools,
    status: "done"
  });
}

function roleFromHydratedMessage(message: Record<string, unknown> | undefined): Role {
  const role = stringField(message?.role);
  return role === "user" || role === "system" ? role : "assistant";
}

function isHydratedToolResult(message: Record<string, unknown> | undefined): boolean {
  return stringField(message?.role) === "toolResult";
}

function extractHydratedContent(content: unknown): Pick<SessionMessage, "content" | "thinking" | "tools"> {
  if (typeof content === "string") {
    return { content, thinking: "", tools: [] };
  }

  if (!Array.isArray(content)) {
    return { content: "", thinking: "", tools: [] };
  }

  const text: string[] = [];
  const thinking: string[] = [];
  const tools: MessageToolPart[] = [];

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

    if (isAssistantToolCall(item)) {
      mergeToolPart({ tools }, toolPartFromToolCall(item));
      continue;
    }

    if (isAssistantToolResult(item)) {
      mergeToolPart({ tools }, toolPartFromHydratedToolResult(item));
    }
  }

  return { content: text.join(""), thinking: thinking.join(""), tools };
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

  if (deltaType && isAssistantToolCall(assistantEvent)) {
    mergeToolPart(message, toolPartFromToolCall(assistantEvent));
  } else if (deltaType && isAssistantToolResult(assistantEvent)) {
    mergeToolPart(message, toolPartFromHydratedToolResult(assistantEvent));
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
    tools: [],
    status
  };
  state.messages.push(message);
  return message;
}

function upsertMessageForStart(state: SessionState, id: string, role: Role, status: MessageStatus): SessionMessage {
  if (role === "assistant") {
    const pendingToolMessage = state.messages.at(-1);
    if (isSyntheticToolMessage(pendingToolMessage)) {
      pendingToolMessage.id = id;
      pendingToolMessage.status = status;
      return pendingToolMessage;
    }
  }

  return upsertMessage(state, id, role, status);
}

function updateTool(state: SessionState, id: string, update: (tool: ToolExecution) => void): void {
  const tool = state.tools.find((item) => item.id === id);
  if (tool) {
    update(tool);
  }
}

function upsertExecutionTool(state: SessionState, event: PiEvent, update: (tool: ToolExecution) => void): void {
  const id = toolId(event);
  let tool = state.tools.find((item) => item.id === id);
  if (!tool) {
    tool = {
      id,
      name: toolName(event) || "tool",
      status: "running",
      input: toolInput(event),
      log: []
    };
    state.tools.push(tool);
  }
  update(tool);
}

function upsertMessageToolPart(
  state: SessionState,
  event: PiEvent,
  options: { status: MessageToolStatus }
): void {
  const key = toolIdentityKey(event);
  const message = assistantMessageForToolPart(state, key);
  mergeToolPart(message, toolPartFromExecutionEvent(event, options.status, key));
}

function assistantMessageForToolPart(state: SessionState, key: string): SessionMessage {
  const messageWithTool = key ? messageForExistingToolPart(state, key) : undefined;
  if (messageWithTool) {
    return messageWithTool;
  }

  const activeMessage = state.activeMessageId
    ? state.messages.find((message) => message.id === state.activeMessageId && message.role === "assistant")
    : undefined;
  if (activeMessage) {
    return activeMessage;
  }

  const latestMessage = state.messages.at(-1);
  if (latestMessage?.role === "assistant") {
    return latestMessage;
  }

  return upsertMessage(state, createId("assistant-tools"), "assistant", "streaming");
}

function messageForExistingToolPart(state: SessionState, key: string): SessionMessage | undefined {
  return state.messages.find((message) => message.tools.some((tool) => tool.key === key || tool.id === key));
}

function isSyntheticToolMessage(message: SessionMessage | undefined): message is SessionMessage {
  return Boolean(
    message &&
      message.role === "assistant" &&
      message.id.startsWith("assistant-tools-") &&
      !message.content &&
      !message.thinking &&
      message.tools.length > 0
  );
}

function mergeToolPart(message: Pick<SessionMessage, "tools">, incoming: MessageToolPart): void {
  const existing = existingToolPart(message.tools, incoming);
  if (!existing) {
    message.tools.push({ ...incoming, statusLabel: toolStatusLabel(incoming.status) });
    return;
  }

  if (incoming.id) {
    existing.id = incoming.id;
  }
  if (incoming.key && existing.key !== incoming.key && !message.tools.some((tool) => tool !== existing && tool.key === incoming.key)) {
    existing.key = incoming.key;
  }
  if (incoming.name !== "tool") {
    existing.name = incoming.name;
    existing.label = incoming.label;
  }
  existing.detail ||= incoming.detail;
  existing.input ??= incoming.input;
  if (incoming.output !== undefined) {
    existing.output = incoming.output;
  }
  existing.rawInput ??= incoming.rawInput;
  if (incoming.rawOutput !== undefined) {
    existing.rawOutput = incoming.rawOutput;
  }

  if (incoming.content) {
    existing.content = incoming.content;
  }

  existing.status = mergedToolStatus(existing.status, incoming.status);
  existing.statusLabel = toolStatusLabel(existing.status);
}

function existingToolPart(tools: MessageToolPart[], incoming: MessageToolPart): MessageToolPart | undefined {
  const exact = tools.find((tool) => (incoming.key && tool.key === incoming.key) || (incoming.id && tool.id === incoming.id));
  if (exact) {
    return exact;
  }

  if ((incoming.status === "done" || incoming.status === "error") && incoming.output !== undefined) {
    const unresolved = tools.filter((tool) => tool.status === "running" && tool.output === undefined);
    if (unresolved.length === 1) {
      return unresolved[0];
    }
  }

  return undefined;
}

function toolPartFromExecutionEvent(event: PiEvent, status: MessageToolStatus, key = toolIdentityKey(event)): MessageToolPart {
  const output = event.output ?? event.result ?? event.partialResult ?? event.delta ?? event.message;
  const content = textFromToolPayload(output) || stringField(output) || jsonDisplay(output);

  return {
    type: "tool",
    key,
    id: key,
    label: toolName(event) || "Tool call",
    name: toolName(event) || "tool",
    detail: toolDetail(event) || undefined,
    status,
    statusLabel: toolStatusLabel(status),
    content,
    input: toolInput(event),
    output,
    rawInput: toolInput(event),
    rawOutput: output
  };
}

function toolPartFromToolCall(event: PiEvent): MessageToolPart {
  const key = toolIdentityKey(event);
  return {
    type: "tool",
    key,
    id: key,
    label: toolName(event) || "Tool call",
    name: toolName(event) || "tool",
    detail: toolDetail(event) || undefined,
    status: "running",
    statusLabel: toolStatusLabel("running"),
    content: "",
    input: toolInput(event),
    rawInput: toolInput(event)
  };
}

function toolPartFromHydratedToolResult(event: PiEvent): MessageToolPart {
  const key = toolIdentityKey(event);
  const failed = isToolError(event);
  const output = event.output ?? event.result ?? event.content;
  return {
    type: "tool",
    key,
    id: key,
    label: toolName(event) || "Tool call",
    name: toolName(event) || "tool",
    detail: toolDetail(event) || undefined,
    status: failed ? "error" : "done",
    statusLabel: toolStatusLabel(failed ? "error" : "done"),
    content: textFromToolPayload(output) || stringField(output) || jsonDisplay(output),
    output,
    rawOutput: output
  };
}

function isToolError(event: PiEvent): boolean {
  const result = objectField(event.result);
  const output = objectField(event.output);
  return (
    event.isError === true ||
    event.is_error === true ||
    event.success === false ||
    event.error === true ||
    result?.isError === true ||
    result?.is_error === true ||
    result?.success === false ||
    result?.error === true ||
    output?.isError === true ||
    output?.is_error === true ||
    output?.success === false ||
    output?.error === true
  );
}

function mergedToolStatus(current: MessageToolStatus, incoming: MessageToolStatus): MessageToolStatus {
  if (incoming === "error" || current === "error") {
    return "error";
  }
  if (incoming === "done") {
    return "done";
  }
  if (current === "done") {
    return "done";
  }
  if (incoming === "running" || current === "running") {
    return "running";
  }
  return "running";
}

function toolStatusLabel(status: MessageToolStatus): string {
  switch (status) {
    case "running":
      return "In progress";
    case "done":
      return "Complete";
    case "error":
      return "Error";
  }
}

function toolPartKey(event: PiEvent | Record<string, unknown> | undefined): string {
  if (!event) {
    return "";
  }
  return firstString(event.toolCallId, event.tool_call_id, event.toolExecutionId, event.tool_execution_id, event.tool_use_id, event.toolUseId, event.id);
}

function toolIdentityKey(event: PiEvent): string {
  return toolPartKey(event) || fallbackToolKey(event) || createId("tool");
}

function fallbackToolKey(event: PiEvent): string {
  return [toolName(event) || "tool", toolDetail(event), jsonDisplay(toolInput(event))].filter(Boolean).join(":");
}

function toolName(event: PiEvent): string {
  return firstDisplayString(event.toolName, event.tool_name, event.name, event.tool, event.function);
}

function toolDetail(event: PiEvent): string {
  if (toolName(event) === "bash") {
    return commandField(event);
  }

  return pathField(event) || commandField(event);
}

function toolInput(event: PiEvent): unknown {
  return event.input ?? event.args ?? objectOrJsonField(event.arguments) ?? objectField(event.tool)?.input ?? objectField(event.tool)?.args;
}

function isAssistantToolCall(event: PiEvent | undefined): event is PiEvent {
  const type = stringField(event?.type);
  return type === "toolCall" || type === "tool_call" || type === "tool_use";
}

function isAssistantToolResult(event: PiEvent | undefined): event is PiEvent {
  const type = stringField(event?.type);
  return type === "toolResult" || type === "tool_result" || stringField(event?.role) === "toolResult";
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

  const sessionPath = stringField(event.sessionPath);
  state.extensionRequests.push({ id, method, params, ...(sessionPath ? { sessionPath } : {}) });
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
  return (
    stringField(event.id) ||
    stringField(event.toolExecutionId) ||
    stringField(event.tool_execution_id) ||
    stringField(event.toolCallId) ||
    stringField(event.tool_call_id) ||
    createId("tool")
  );
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function applyCompleteMessage(message: SessionMessage, event: PiEvent): void {
  const eventMessage = objectField(event.message);
  const content = eventMessage?.content;
  if (!content) {
    return;
  }

  if (typeof content === "string") {
    if (!message.content) {
      message.content = content;
    }
    return;
  }

  if (Array.isArray(content)) {
    const extracted = extractHydratedContent(content);
    if (extracted.content && !message.content) {
      message.content = extracted.content;
    }
    if (extracted.thinking && !message.thinking) {
      message.thinking = extracted.thinking;
    }
    for (const tool of extracted.tools) {
      mergeToolPart(message, tool);
    }
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

function textFromToolPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const item = objectField(part);
        return stringField(item?.text);
      })
      .filter(Boolean)
      .join("");
  }

  return textFromContent(value);
}

function jsonDisplay(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function commandField(event: PiEvent): string {
  const args = objectField(event.args);
  const input = objectField(event.input);
  const argumentsValue = objectOrJsonField(event.arguments);
  const tool = objectField(event.tool);
  const toolArgs = objectField(tool?.args);
  const toolInput = objectField(tool?.input);
  const toolArguments = objectOrJsonField(tool?.arguments);
  const functionValue = objectField(event.function);
  const functionArgs = objectField(functionValue?.args);
  const functionInput = objectField(functionValue?.input);
  const functionArguments = objectOrJsonField(functionValue?.arguments);
  return firstString(
    args?.command,
    input?.command,
    argumentsValue?.command,
    toolArgs?.command,
    toolInput?.command,
    toolArguments?.command,
    tool?.command,
    functionArgs?.command,
    functionInput?.command,
    functionArguments?.command,
    functionValue?.command,
    event.command
  );
}

function pathField(event: PiEvent): string {
  const args = objectField(event.args);
  const input = objectField(event.input);
  const argumentsValue = objectOrJsonField(event.arguments);
  const tool = objectField(event.tool);
  const toolArgs = objectField(tool?.args);
  const toolInput = objectField(tool?.input);
  const toolArguments = objectOrJsonField(tool?.arguments);
  const functionValue = objectField(event.function);
  const functionArgs = objectField(functionValue?.args);
  const functionInput = objectField(functionValue?.input);
  const functionArguments = objectOrJsonField(functionValue?.arguments);
  return firstString(
    event.path,
    event.file_path,
    event.filePath,
    args?.path,
    args?.file_path,
    args?.filePath,
    input?.path,
    input?.file_path,
    input?.filePath,
    argumentsValue?.path,
    argumentsValue?.file_path,
    argumentsValue?.filePath,
    tool?.path,
    tool?.file_path,
    tool?.filePath,
    toolArgs?.path,
    toolArgs?.file_path,
    toolArgs?.filePath,
    toolInput?.path,
    toolInput?.file_path,
    toolInput?.filePath,
    toolArguments?.path,
    toolArguments?.file_path,
    toolArguments?.filePath,
    functionValue?.path,
    functionValue?.file_path,
    functionValue?.filePath,
    functionArgs?.path,
    functionArgs?.file_path,
    functionArgs?.filePath,
    functionInput?.path,
    functionInput?.file_path,
    functionInput?.filePath,
    functionArguments?.path,
    functionArguments?.file_path,
    functionArguments?.filePath
  );
}

function objectOrJsonField(value: unknown): Record<string, unknown> | undefined {
  const object = objectField(value);
  if (object && !Array.isArray(object)) {
    return object;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = objectField(parseJson(value));
  return parsed && !Array.isArray(parsed) ? parsed : undefined;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function firstDisplayString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringField(value).trim();
    if (text && !looksLikeUuid(text)) {
      return text;
    }

    const object = objectField(value);
    if (object) {
      const nested = firstDisplayString(object.name, object.displayName, object.label, object.id);
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
