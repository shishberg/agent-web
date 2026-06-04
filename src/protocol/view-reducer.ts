import type { AssistantMessageItem, AssistantToolPart, ConversationItem, SessionView, ViewPatch } from "./types";

/**
 * Pure reducer: applies a single ViewPatch to a SessionView and returns the
 * new state.  Does not mutate the input.
 */
export function applyViewPatch(
  view: SessionView,
  patch: ViewPatch,
): SessionView {
  switch (patch.type) {
    case "appendItem":
      return appendItem(view, patch.item);
    case "updateItem":
      return updateItem(view, patch.id, patch.partial);
    case "upsertAssistantTool":
      return upsertAssistantTool(view, patch.assistantId, patch.tool);
    case "setStatus":
      return setStatus(view, patch.status, patch.statusText);
    case "setPendingRequest":
      return setPendingRequest(view, patch.request);
    case "clearPendingRequest":
      return clearPendingRequest(view, patch.id);
    case "setExtensionDraft":
      return setExtensionDraft(view, patch.text);
    case "setCursor":
      return setCursor(view, patch.cursor);
    case "setSession":
      return setSession(view, patch.session);
  }
}

function appendItem(view: SessionView, item: ConversationItem): SessionView {
  return {
    ...view,
    items: [...view.items, item],
  };
}

function updateItem(
  view: SessionView,
  id: string,
  partial: Partial<ConversationItem>,
): SessionView {
  return {
    ...view,
    items: view.items.map((item) =>
      item.id === id ? (mergeItem(item, partial) as ConversationItem) : item,
    ),
  };
}

function upsertAssistantTool(
  view: SessionView,
  assistantId: string,
  tool: Partial<AssistantToolPart> & { id: string },
): SessionView {
  return {
    ...view,
    items: view.items.map((item) => {
      if (item.kind !== "assistant" || item.id !== assistantId) {
        return item;
      }
      return mergeAssistantTool(item, tool);
    }),
  };
}

function setStatus(
  view: SessionView,
  status: SessionView["status"],
  statusText?: string,
): SessionView {
  return {
    ...view,
    status,
    statusText: statusText ?? statusTextForStatus(status, view.statusText),
  };
}

function setPendingRequest(
  view: SessionView,
  request: SessionView["pendingRequests"][number],
): SessionView {
  return {
    ...view,
    pendingRequests: [...view.pendingRequests, request],
    status: "blocked",
  };
}

function clearPendingRequest(
  view: SessionView,
  id: string,
): SessionView {
  const pendingRequests = view.pendingRequests.filter((r) => r.id !== id);
  return {
    ...view,
    pendingRequests,
    status: pendingRequests.length > 0 ? "blocked" : view.status === "blocked" ? "running" : view.status,
  };
}

function setExtensionDraft(
  view: SessionView,
  text: string,
): SessionView {
  return {
    ...view,
    extensionDraft: text,
  };
}

function setCursor(view: SessionView, cursor: string): SessionView {
  return {
    ...view,
    cursor,
  };
}

function setSession(
  view: SessionView,
  session: SessionView["session"],
): SessionView {
  return {
    ...view,
    session,
  };
}

// ── helpers ──

function mergeItem(
  item: ConversationItem,
  partial: Partial<ConversationItem>,
): ConversationItem {
  // Shallow-merge top-level fields, then deep-merge specific sub-structures.
  const merged = { ...item, ...partial };

  // Deep-merge content arrays when the partial provides a kind-compatible content update
  if (partial.kind === item.kind && "content" in partial && "content" in item) {
    (merged as Record<string, unknown>).content = mergeContent(item, partial as Partial<ConversationItem>);
  }

  // Deep-merge thinking arrays
  if (
    item.kind === "assistant" &&
    partial.kind === "assistant" &&
    "thinking" in partial
  ) {
    const existingThinking = "thinking" in item ? item.thinking : undefined;
    const partialThinking = (partial as { thinking?: unknown[] }).thinking;
    if (partialThinking && existingThinking) {
      (merged as { thinking: unknown[] }).thinking = mergeBlockArrays(
        existingThinking,
        partialThinking,
      );
    }
  }

  if (
    item.kind === "assistant" &&
    partial.kind === "assistant" &&
    "tools" in partial
  ) {
    (merged as AssistantMessageItem).tools = mergeAssistantToolLists(
      item.tools ?? [],
      partial.tools ?? [],
    );
  }

  return merged as ConversationItem;
}

function mergeAssistantTool(
  item: AssistantMessageItem,
  incoming: Partial<AssistantToolPart> & { id: string },
): AssistantMessageItem {
  return {
    ...item,
    tools: mergeAssistantToolLists(item.tools ?? [], [incoming]),
  };
}

function mergeAssistantToolLists(
  existing: AssistantToolPart[],
  incoming: Array<Partial<AssistantToolPart> & { id: string }>,
): AssistantToolPart[] {
  let result = [...existing];
  for (const tool of incoming) {
    const index = result.findIndex((item) => item.id === tool.id);
    if (index === -1) {
      result = [...result, completeAssistantTool(tool)];
      continue;
    }
    result[index] = mergeAssistantToolPart(result[index], tool);
  }
  return result;
}

function completeAssistantTool(
  tool: Partial<AssistantToolPart> & { id: string },
): AssistantToolPart {
  return {
    id: tool.id,
    name: tool.name ?? "tool",
    label: tool.label ?? tool.name ?? "Tool call",
    status: tool.status ?? "pending",
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
    ...(tool.output !== undefined ? { output: tool.output } : {}),
    ...(tool.content !== undefined ? { content: tool.content } : {}),
  };
}

function mergeAssistantToolPart(
  existing: AssistantToolPart,
  incoming: Partial<AssistantToolPart> & { id: string },
): AssistantToolPart {
  return {
    ...existing,
    ...definedAssistantToolFields(incoming),
    id: existing.id,
    status: mergeAssistantToolStatus(existing.status, incoming.status),
  };
}

function definedAssistantToolFields(
  tool: Partial<AssistantToolPart>,
): Partial<AssistantToolPart> {
  const fields: Partial<AssistantToolPart> = {};
  if (tool.name !== undefined) fields.name = tool.name;
  if (tool.label !== undefined) fields.label = tool.label;
  if (tool.input !== undefined) fields.input = tool.input;
  if (tool.detail !== undefined) fields.detail = tool.detail;
  if (tool.output !== undefined) fields.output = tool.output;
  if (tool.content !== undefined) fields.content = tool.content;
  return fields;
}

function mergeAssistantToolStatus(
  existing: AssistantToolPart["status"],
  incoming?: AssistantToolPart["status"],
): AssistantToolPart["status"] {
  if (!incoming) return existing;
  if (existing === "error" || incoming === "error") return "error";
  if (existing === "done") return "done";
  if (incoming === "done") return "done";
  if (existing === "running" && incoming === "pending") return "running";
  return incoming;
}

function mergeContent(
  item: ConversationItem,
  partial: Partial<ConversationItem>,
): unknown[] {
  const origContent =
    "content" in item ? (item.content as unknown[]) : [];
  const partialContent =
    "content" in partial ? (partial.content as unknown[]) : [];
  return mergeBlockArrays(origContent, partialContent);
}

/**
 * Merge two content/thinking block arrays by position.
 *
 * Text blocks at the same position are merged by appending incoming text
 * to existing text, unless the incoming text already starts with the
 * existing text (i.e. the incoming is a full accumulated update from
 * message_end), in which case the incoming replaces the existing.
 *
 * Non-text blocks and position mismatches replace the original at that
 * position.  Extra incoming blocks beyond the original length are appended.
 */
function mergeBlockArrays(
  original: unknown[],
  incoming: unknown[],
): unknown[] {
  if (incoming.length === 0) {
    return original;
  }
  if (original.length === 0) {
    return incoming;
  }

  const result = [...original];
  for (let i = 0; i < incoming.length; i++) {
    const inc = incoming[i];
    const existing = i < result.length ? result[i] : undefined;

    const incField = blockTextField(inc);
    const existingField = blockTextField(existing);

    if (
      incField !== null &&
      existingField !== null &&
      incField === existingField
    ) {
      const incText = (inc as Record<string, unknown>)[incField] as string;
      const existingText = (existing as Record<string, unknown>)[existingField] as string;
      // If incoming text starts with existing text, it's a full
      // accumulated update — replace rather than append.
      if (incText.startsWith(existingText)) {
        result[i] = inc;
      } else {
        result[i] = { ...(existing as Record<string, unknown>), [incField]: existingText + incText };
      }
    } else if (i < result.length) {
      result[i] = inc;
    } else {
      result.push(inc);
    }
  }

  return result;
}

// ── block helpers ──

/**
 * Check whether a value looks like a block with a single text-like string
 * field that should be appended during merge (text, thinking).
 */
function blockTextField(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const blockType = rec.type;
  if (blockType === "text" && typeof rec.text === "string") {
    return "text";
  }
  if (blockType === "thinking" && typeof rec.thinking === "string") {
    return "thinking";
  }
  return null;
}

function statusTextForStatus(
  status: SessionView["status"],
  current: string,
): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "connected":
      return current === "Agent running" || current === "Running" ? "Agent finished" : "Connected";
    case "connecting":
      return "Connecting";
    case "running":
      return "Agent running";
    case "blocked":
      return "Waiting for input";
    case "failed":
      return "Error";
    case "stopped":
      return "Stopped";
    default:
      return current;
  }
}
