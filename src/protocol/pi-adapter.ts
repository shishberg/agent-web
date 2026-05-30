/**
 * Pi adapter: converts raw Pi session files and stream events into the
 * Session View protocol types.
 *
 * This is the **only** module that knows Pi's persistence and stream shapes.
 * Every other module in agent-web consumes SessionView / ViewPatch types.
 */
import { normalizeStreamEvent, normalizeTranscript } from "../lib/transcriptNormalizer";
import type {
  AssistantMessageItem,
  ContentBlock,
  ConversationItem,
  RunStatus,
  SessionSummary,
  SessionView,
  ToolItem,
  UserMessageItem,
  UserRequest,
  ViewPatch,
} from "./types";
import { createEmptySessionView } from "./types";

// ── Snapshot adapter ──

/**
 * Convert a raw Pi session transcript (session-file records) into a
 * SessionView suitable for UI hydration.
 *
 * - Unwraps `{ type: "message", message: { ... } }` records.
 * - Preserves wrapper-level `id` / `timestamp` / `responseId` as fallbacks.
 * - Skips non-message metadata records.
 * - Sets initial status to "connected" when items are present (loaded session),
 *   or "idle" when empty (new session).
 */
export function piSnapshotToView(records: unknown[]): SessionView {
  const normalized = normalizeTranscript(records);
  const items: ConversationItem[] = [];

  for (const record of normalized) {
    const convItem = toConversationItem(record);
    if (convItem) {
      items.push(convItem);
    }
  }

  const session = inferSessionSummary(records);
  const view = createEmptySessionView(session);
  view.items = items;
  view.status = items.length > 0 ? "connected" : "idle";
  view.statusText = items.length > 0 ? "Session loaded" : "No messages yet";
  view.cursor = "";

  return view;
}

// ── Stream event adapter ──

/**
 * Convert one raw Pi stream event into zero or one ViewPatch.
 * Returns null when the event does not produce a view-level change.
 *
 * Works on a shallow copy so the caller's event is never mutated.
 *
 * @param event  Raw Pi stream event (AgentSessionEvent or Pi CLI event).
 * @param state  Optional current SessionView for context-dependent
 *               transitions (e.g. failure detection, fire-and-forget
 *               guard).  When omitted the adapter uses safe defaults.
 *
 * Callers should apply the resulting patch with {@link applyViewPatch}.
 */
export function piStreamEventToPatch(
  event: Record<string, unknown>,
  state?: SessionView,
): ViewPatch | null {
  // Normalize a shallow copy so the caller's event is not mutated
  const evt = { ...event };
  if (isRecord(evt.message)) {
    evt.message = { ...evt.message as Record<string, unknown> };
  }
  normalizeStreamEvent(evt);

  const type = String(evt.type ?? "");

  switch (type) {
    case "message_start": {
      const msg = recordField(evt.message);
      if (!msg || stringField(msg.role) === "user") return null;
      const convItem = toConversationItem(msg);
      if (!convItem) return null;
      return { type: "appendItem", item: convItem };
    }
    case "message_update": {
      let msg = recordField(evt.message);
      if (!msg || stringField(msg.role) === "user") return null;

      // When message.content is absent, extract text/thinking deltas from
      // assistantMessageEvent so the patch carries streaming content.
      if (!msg.content) {
        const deltaBlocks = extractDeltaBlocks(evt);
        if (deltaBlocks.length > 0) {
          msg = { ...msg, content: deltaBlocks };
        }
      }

      const id = messageIdFromEvent(evt);
      if (!id) return null;
      const convItem = toConversationItem(msg);
      if (!convItem) return null;
      return { type: "updateItem", id, partial: convItem };
    }
    case "message_end": {
      const msg = recordField(evt.message);
      if (!msg || stringField(msg.role) === "user") return null;
      const id = messageIdFromEvent(evt);
      if (!id) return null;
      const convItem = toConversationItem(msg);
      if (!convItem) return null;
      return { type: "updateItem", id, partial: { ...convItem } };
    }
    case "tool_execution_start": {
      const toolItem = toToolItem(evt, "running");
      if (!toolItem) return null;
      return { type: "appendItem", item: toolItem };
    }
    case "tool_execution_update": {
      const id = executionToolId(evt);
      if (!id) return null;
      const partial = toolEndPartial(evt, "running");
      if (!partial) return null;
      return { type: "updateItem", id, partial };
    }
    case "tool_execution_end": {
      const id = executionToolId(evt);
      if (!id) return null;
      const status = isToolError(evt) ? "error" : "done";
      const partial = toolEndPartial(evt, status as ToolItem["status"]);
      if (!partial) return null;
      return { type: "updateItem", id, partial };
    }
    case "agent_start":
      return { type: "setStatus", status: "running", statusText: "Agent running" };
    case "agent_end": {
      // If the agent will retry, don't change status — auto_retry_start
      // will fire next and produce its own status patch.
      if (evt.willRetry === true) {
        return null;
      }

      const currentStatus = state?.status;

      // If the agent end carries an explicit failure indicator, set failed.
      if (isAgentFailure(evt, currentStatus)) {
        const failText = agentFailureText(evt);
        return { type: "setStatus", status: "failed", statusText: failText };
      }

      // Normal completion: transition from running → connected.
      // Guard: don't overwrite terminal states (blocked, failed, stopped)
      // that may have been set by extension requests or explicit stops.
      if (currentStatus && isTerminalStatus(currentStatus)) {
        return null;
      }
      return { type: "setStatus", status: "connected", statusText: "Agent finished" };
    }
    case "turn_start":
    case "turn_end":
      // Internal bookkeeping only — no view-level change.
      return null;
    case "extension_ui_request": {
      const method = String(evt.method ?? "");
      // set_editor_text is a draft update, not a generic fire-and-forget
      if (method === "set_editor_text") {
        const params = recordField(evt.params) ?? {};
        const text = stringField(params.text);
        return { type: "setExtensionDraft", text };
      }
      // Fire-and-forget notifications: status text update only.
      // Guard: don't clobber terminal states (blocked, failed, stopped).
      if (isFireAndForgetExtensionMethod(method)) {
        const currentStatus = state?.status;
        if (currentStatus && isTerminalStatus(currentStatus)) {
          // Don't override a terminal status with a transient notification.
          return null;
        }
        const params = recordField(evt.params) ?? {};
        const text =
          stringField(params.statusText) ||
          stringField(params.message) ||
          stringField(params.status) ||
          stringField(params.title) ||
          method;
        return { type: "setStatus", status: "running", statusText: text };
      }
      // Blocking extension request
      const request: UserRequest = {
        id: stringField(evt.id) || deterministicFallbackId("ext", evt),
        method,
        params: extensionParams(evt),
      };
      return { type: "setPendingRequest", request };
    }
    case "set_editor_text": {
      const text = stringField(evt.text) || stringField(evt.params) || "";
      return { type: "setExtensionDraft", text };
    }
    case "compaction_start":
      return { type: "setStatus", status: "running", statusText: "Compacting session" };
    case "compaction_end":
      return { type: "setStatus", status: "running", statusText: "Compaction complete" };
    case "auto_retry_start":
      return { type: "setStatus", status: "running", statusText: "Auto retry running" };
    case "auto_retry_end": {
      // If the final retry exhausted all attempts, set failed.
      if (evt.success === false) {
        const failText =
          stringField(evt.finalError) ||
          stringField(evt.errorMessage) ||
          "Auto retry failed";
        return { type: "setStatus", status: "failed", statusText: failText };
      }
      // If state is already failed (e.g. from a bridge error), preserve it.
      if (state?.status === "failed") {
        return null;
      }
      return { type: "setStatus", status: "running", statusText: "Auto retry finished" };
    }
    default:
      return null;
  }
}

// ── Conversation item builders ──

function toConversationItem(value: unknown): ConversationItem | null {
  if (!isRecord(value)) return null;

  const role = stringField(value.role);
  const id = firstString(
    stringField(value.id),
    stringField(value.responseId),
    typeof value.timestamp === "number" ? String(value.timestamp) : "",
  ) || deterministicFallbackId("pi-item", value);

  const timestamp =
    typeof value.timestamp === "number"
      ? value.timestamp
      : undefined;

  if (role === "user") {
    const content = contentToBlocks(value.content);
    return {
      id,
      timestamp,
      kind: "user",
      content,
    } satisfies UserMessageItem;
  }

  if (role === "assistant") {
    const { content, thinking } = extractAssistantContent(value);
    return {
      id,
      timestamp,
      kind: "assistant",
      content,
      thinking: thinking.length > 0 ? thinking : undefined,
      provider: stringField(value.provider) || undefined,
      model: stringField(value.model) || undefined,
      usage: recordField(value.usage) as AssistantMessageItem["usage"] | undefined,
    } satisfies AssistantMessageItem;
  }

  // Unrecognized role — skip
  return null;
}

function toToolItem(
  event: Record<string, unknown>,
  status: ToolItem["status"],
): ToolItem | null {
  const id = executionToolId(event);
  if (!id) return null;

  const name = toolName(event);
  const output = event.output ?? event.result ?? event.partialResult ?? event.delta ?? event.message;
  const outputContent = textFromToolPayload(output);

  return {
    id,
    kind: "tool",
    toolName: name || "tool",
    toolLabel: name || "Tool call",
    detail: toolDetail(event) || undefined,
    input: event.input ?? event.args ?? recordField(event.arguments) ?? recordField(event.tool)?.input ?? recordField(event.tool)?.args,
    output,
    status,
  } satisfies ToolItem;
}

/**
 * Build a partial tool item for update patches (tool_execution_update / tool_execution_end).
 * Only includes fields that the event actually carries, so existing fields on the item
 * (like toolName from the start event) are not overwritten with empty values.
 */
function toolEndPartial(
  event: Record<string, unknown>,
  status: ToolItem["status"],
): Partial<ToolItem> | null {
  const id = executionToolId(event);
  if (!id) return null;

  const name = toolName(event);
  const output = event.output ?? event.result ?? event.partialResult ?? event.delta ?? event.message;

  const partial: Partial<ToolItem> = {
    kind: "tool",
    status,
  };

  if (name) {
    partial.toolName = name;
    partial.toolLabel = name;
  }
  if (output !== undefined) {
    partial.output = output;
  }
  const detail = toolDetail(event);
  if (detail) {
    partial.detail = detail;
  }
  const input = event.input ?? event.args ?? recordField(event.arguments) ?? recordField(event.tool)?.input ?? recordField(event.tool)?.args;
  if (input !== undefined) {
    partial.input = input;
  }

  return partial;
}

// ── Content extraction helpers ──

function contentToBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content as ContentBlock[];
  }
  return [];
}

function extractAssistantContent(value: Record<string, unknown>): {
  content: ContentBlock[];
  thinking: ContentBlock[];
} {
  const rawContent = value.content;

  if (typeof rawContent === "string") {
    return { content: [{ type: "text", text: rawContent }], thinking: [] };
  }

  if (!Array.isArray(rawContent)) {
    return { content: [], thinking: [] };
  }

  const content: ContentBlock[] = [];
  const thinking: ContentBlock[] = [];

  for (const part of rawContent) {
    if (!isRecord(part)) continue;

    if (stringField(part.text)) {
      content.push({ type: "text", text: stringField(part.text) });
    } else if (stringField(part.thinking)) {
      thinking.push({ type: "thinking", thinking: stringField(part.thinking) });
    } else {
      // Pass through unknown blocks
      content.push(part as unknown as ContentBlock);
    }
  }

  return { content, thinking };
}

// ── Delta extraction (streaming text / thinking) ──

/**
 * Extract text / thinking content blocks from an assistantMessageEvent delta
 * when the message object itself does not carry content.
 */
function extractDeltaBlocks(event: Record<string, unknown>): ContentBlock[] {
  const delta = recordField(event.assistantMessageEvent);
  if (!delta) return [];

  const deltaType = stringField(delta.type);

  // Direct text delta: { type: "text_delta", delta: "Hello" }
  if (deltaType === "text_delta") {
    const text = stringField(delta.delta) || stringField(delta.text);
    if (text) return [{ type: "text", text }];
  }

  // Direct thinking delta: { type: "thinking_delta", thinking: "Hmm" }
  if (deltaType === "thinking_delta") {
    const thinking = stringField(delta.thinking) || stringField(delta.delta);
    if (thinking) return [{ type: "thinking", thinking }];
  }

  // Nested delta via content_block_delta:
  // { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }
  if (deltaType === "content_block_delta") {
    const inner = recordField(delta.delta);
    if (!inner) return [];
    const innerType = stringField(inner.type);
    if (innerType === "text_delta") {
      const text = stringField(inner.text) || stringField(inner.delta);
      if (text) return [{ type: "text", text }];
    }
    if (innerType === "thinking_delta") {
      const thinking = stringField(inner.thinking) || stringField(inner.delta);
      if (thinking) return [{ type: "thinking", thinking }];
    }
  }

  return [];
}

// ── Session summary inference ──

function inferSessionSummary(records: unknown[]): SessionSummary {
  // Try to extract session metadata from session-file records
  for (const record of records) {
    if (!isRecord(record)) continue;
    if (record.type === "session" && isRecord(record)) {
      return {
        id: stringField(record.id),
        title: stringField(record.title) || "Loaded session",
        status: "idle",
        kind: stringField(record.kind) || undefined,
        sessionPath: stringField(record.sessionPath) || stringField(record.path) || undefined,
        metadata: recordField(record.metadata) ?? undefined,
      };
    }
  }
  return { id: "", title: "Loaded session", status: "idle" };
}

// ── Helpers ──

function messageIdFromEvent(event: Record<string, unknown>): string | null {
  const message = recordField(event.message);
  if (!message) return null;

  const id = stringField(message.id);
  if (id) return id;

  // Synthesized id from normalizeStreamEvent
  return null;
}

function executionToolId(event: Record<string, unknown>): string {
  return firstString(
    stringField(event.toolCallId),
    stringField(event.tool_call_id),
  );
}

function toolName(event: Record<string, unknown>): string {
  return firstDisplayString(
    stringField(event.toolName),
    stringField(event.tool_name),
    stringField(event.name),
    stringField(event.tool),
    stringField(event.function),
  );
}

function toolDetail(event: Record<string, unknown>): string {
  if (toolName(event) === "bash") {
    return commandField(event);
  }
  return pathField(event) || commandField(event);
}

function isToolError(event: Record<string, unknown>): boolean {
  const result = recordField(event.result);
  const output = recordField(event.output);
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

function isFireAndForgetExtensionMethod(method: string): boolean {
  return ["notify", "setStatus", "setWidget", "setTitle"].includes(method);
}

function extensionParams(event: Record<string, unknown>): Record<string, unknown> {
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

function textFromToolPayload(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!isRecord(part)) return "";
        return stringField(part.text);
      })
      .filter(Boolean)
      .join("");
  }

  if (isRecord(value) && Array.isArray(value.content)) {
    return (value.content as unknown[])
      .map((part) => {
        if (!isRecord(part)) return "";
        return stringField(part.text);
      })
      .filter(Boolean)
      .join("");
  }

  if (value !== undefined && value !== null) {
    return JSON.stringify(value, null, 2);
  }

  return "";
}

function commandField(event: Record<string, unknown>): string {
  const args = recordField(event.args);
  const input = recordField(event.input);
  const argumentsValue = recordOrJsonField(event.arguments);
  const tool = recordField(event.tool);
  return firstString(
    args?.command,
    input?.command,
    argumentsValue?.command,
    tool?.command,
    recordField(tool?.args)?.command,
    recordField(tool?.input)?.command,
    recordOrJsonField(tool?.arguments)?.command,
    event.command,
  );
}

function pathField(event: Record<string, unknown>): string {
  const args = recordField(event.args);
  const input = recordField(event.input);
  const tool = recordField(event.tool);
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
    tool?.path,
    tool?.file_path,
    tool?.filePath,
    recordField(tool?.input)?.path,
    recordField(tool?.input)?.file_path,
    recordField(tool?.input)?.filePath,
  );
}

function recordOrJsonField(value: unknown): Record<string, unknown> | undefined {
  const obj = recordField(value);
  if (obj) return obj;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return recordField(parsed);
  } catch {
    return undefined;
  }
}

function firstDisplayString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringField(value).trim();
    if (text && !looksLikeUuid(text)) return text;

    if (isRecord(value)) {
      const nested = firstDisplayString(
        stringField(value.name),
        stringField(value.displayName),
        stringField(value.label),
        stringField(value.id),
      );
      if (nested) return nested;
    }
  }
  return "";
}

// ── Generic helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Deterministic fallback id using event-type + available fields.
 * Avoids Date.now() so replay is stable.
 */
function deterministicFallbackId(prefix: string, record: Record<string, unknown>): string {
  const ts = typeof record.timestamp === "number" ? String(record.timestamp) : "";
  const sid = stringField(record.sessionId) || stringField(record.session_id);
  const parts = [prefix, sid, ts].filter(Boolean);
  return parts.join("-") || `${prefix}-unknown`;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ── Status & failure helpers ──

/**
 * Check whether the current status is terminal — it should not be
 * overwritten by transient status changes from fire-and-forget extension
 * notifications or intermediate lifecycle events.
 */
function isTerminalStatus(status: RunStatus): boolean {
  return status === "blocked" || status === "failed" || status === "stopped";
}

/**
 * Detect whether the agent run ended with a failure rather than a clean
 * completion.  Looks for:
 * - Explicit `success: false` on the event.
 * - Last assistant message in the transcript with stop reason `"error"` or
 *   `"aborted"`, or with an `errorMessage` field.
 * - Error message on the event itself.
 */
function isAgentFailure(
  event: Record<string, unknown>,
  currentStatus?: RunStatus,
): boolean {
  // Explicit failure flag
  if (event.success === false) return true;
  if (event.failed === true) return true;

  // Check messages transcript for error/aborted signals.
  // agent_end.messages is the full transcript; the relevant failure
  // comes from the last assistant message, not necessarily the final
  // array element (which could be a tool result).
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const lastAssistant = getLastAssistantMessage(messages);
  if (lastAssistant) {
    const stopReason = stringField(lastAssistant.stopReason) || stringField(lastAssistant.stop_reason);
    if (stopReason === "error" || stopReason === "aborted") return true;
    if (typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage) return true;
  }

  // Also check any message content for error tool results.
  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && block.type === "tool_result" && block.is_error === true) {
          return true;
        }
      }
    }
  }

  // Error message on event
  if (typeof event.errorMessage === "string" && event.errorMessage) return true;
  if (typeof event.error === "string" && event.error) return true;

  // If the current status was already "failed" (e.g. from a bridge error),
  // treat the agent_end as confirming the failure.
  if (currentStatus === "failed") return true;

  return false;
}

function agentFailureText(event: Record<string, unknown>): string {
  // Prefer explicit error message
  const explicit = stringField(event.errorMessage) || stringField(event.error);
  if (explicit) return explicit;

  // Extract from messages: scan backward for last assistant message
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const lastAssistant = getLastAssistantMessage(messages);
  if (lastAssistant) {
    const errorMsg = stringField(lastAssistant.errorMessage);
    if (errorMsg) return errorMsg;

    const stopReason = stringField(lastAssistant.stopReason) || stringField(lastAssistant.stop_reason);
    if (stopReason === "error") return "Agent error";
    if (stopReason === "aborted") return "Agent aborted";
  }

  return "Agent failed";
}

/**
 * Scan the transcript backward to find the last assistant message.
 * The last element of agent_end.messages may be a tool_result, user
 * message, or system notice — not the assistant message that reported
 * the failure.
 */
function getLastAssistantMessage(
  messages: unknown[],
): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && msg.role === "assistant") {
      return msg;
    }
  }
  return undefined;
}
