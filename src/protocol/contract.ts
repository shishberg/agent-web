import type { ConversationItem, SessionView } from "./types";

const RUN_STATUSES = new Set([
  "idle",
  "connected",
  "connecting",
  "running",
  "blocked",
  "failed",
  "stopped",
]);

const ITEM_KINDS = new Set(["user", "assistant", "tool", "notice"]);
const TOOL_STATUSES = new Set(["pending", "running", "done", "error"]);
const FORBIDDEN_PI_BLOCK_TYPES = new Set([
  "message",
  "session",
  "model_change",
  "thinking_level_change",
]);

export function assertValidSessionView(view: unknown): asserts view is SessionView {
  if (!isRecord(view)) throw new Error("SessionView must be an object");
  if (!isRecord(view.session)) throw new Error("SessionView.session must be an object");
  if (typeof view.session.id !== "string") throw new Error("SessionView.session.id must be a string");
  if (typeof view.session.status !== "string") throw new Error("SessionView.session.status must be a string");
  if (typeof view.status !== "string" || !RUN_STATUSES.has(view.status)) {
    throw new Error(`view.status must be a recognised RunStatus, got ${String(view.status)}`);
  }
  if (typeof view.statusText !== "string") throw new Error("SessionView.statusText must be a string");
  if (typeof view.cursor !== "string") throw new Error("SessionView.cursor must be a string");
  if (view.extensionDraft !== null && typeof view.extensionDraft !== "string") {
    throw new Error("extensionDraft must be string or null");
  }
  if (!Array.isArray(view.pendingRequests)) throw new Error("SessionView.pendingRequests must be an array");
  if (!Array.isArray(view.items)) throw new Error("SessionView.items must be an array");

  for (const item of view.items) {
    assertValidConversationItem(item);
  }
}

export function assertNoRawPiRecords(view: unknown): void {
  if (!isRecord(view)) throw new Error("SessionView must be an object");
  if (!Array.isArray(view.items)) throw new Error("SessionView.items must be an array");

  for (const item of view.items) {
    if (!isRecord(item)) continue;
    if ("type" in item) throw new Error("item must not have a raw Pi 'type' property");
    if ("message" in item) throw new Error("item must not have a nested 'message' property");
    if ("responseId" in item) throw new Error("item must not have a 'responseId' property");
    if ("stopReason" in item) throw new Error("item must not have a 'stopReason' property");
    if ("stop_reason" in item) throw new Error("item must not have a 'stop_reason' property");

    if (Array.isArray(item.content)) {
      scanBlocks(item.content, `${String(item.kind)}.content`);
    }
    if (item.kind === "assistant" && Array.isArray(item.thinking)) {
      scanBlocks(item.thinking, "assistant.thinking");
    }
  }
}

function assertValidConversationItem(item: unknown): asserts item is ConversationItem {
  if (!isRecord(item)) throw new Error("ConversationItem must be an object");
  if (typeof item.id !== "string" || item.id.length === 0) throw new Error("item.id must be truthy");
  if (typeof item.kind !== "string" || !ITEM_KINDS.has(item.kind)) {
    throw new Error(`item.kind must be a recognised kind, got ${String(item.kind)}`);
  }

  if ((item.kind === "user" || item.kind === "assistant") && !Array.isArray(item.content)) {
    throw new Error(`${item.kind} item must have a content array`);
  }

  if (item.kind === "assistant" && item.tools !== undefined) {
    if (!Array.isArray(item.tools)) throw new Error("assistant item tools must be an array");
    for (const tool of item.tools) {
      assertValidAssistantTool(tool);
    }
  }

  if (item.kind === "tool") {
    if (typeof item.toolName !== "string") throw new Error("Tool item toolName must be a string");
    if (typeof item.toolLabel !== "string") throw new Error("Tool item toolLabel must be a string");
    if (typeof item.status !== "string" || !TOOL_STATUSES.has(item.status)) {
      throw new Error(`tool item must have a valid status, got ${String(item.status)}`);
    }
  }

  if (item.kind === "notice") {
    if (typeof item.text !== "string") throw new Error("Notice item text must be a string");
    if (typeof item.noticeType !== "string") throw new Error("Notice item noticeType must be a string");
  }
}

function assertValidAssistantTool(tool: unknown): void {
  if (!isRecord(tool)) throw new Error("assistant tool must be an object");
  if (typeof tool.id !== "string" || tool.id.length === 0) throw new Error("assistant tool id must be truthy");
  if (typeof tool.name !== "string") throw new Error("assistant tool name must be a string");
  if (typeof tool.label !== "string") throw new Error("assistant tool label must be a string");
  if (typeof tool.status !== "string" || !TOOL_STATUSES.has(tool.status)) {
    throw new Error(`assistant tool must have a valid status, got ${String(tool.status)}`);
  }
}

function scanBlocks(blocks: unknown[], path: string): void {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!isRecord(block)) continue;
    const type = typeof block.type === "string" ? block.type : "";
    if (FORBIDDEN_PI_BLOCK_TYPES.has(type)) {
      throw new Error(`${path}[${index}] ${forbiddenBlockMessage(type)}`);
    }
    if (type === "tool_result" && Array.isArray(block.content)) {
      scanBlocks(block.content, `${path}[${index}].content`);
    }
  }
}

function forbiddenBlockMessage(type: string): string {
  if (type === "message") return "must not be a 'message' wrapper";
  return `must not be a '${type}' metadata record`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
