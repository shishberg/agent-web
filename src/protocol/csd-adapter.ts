import { applyViewPatch } from "./view-reducer";
import { createEmptySessionView } from "./types";
import type {
  AdapterContext,
  AssistantMessageItem,
  SessionSummary,
  SessionView,
  UserMessageItem,
  UserRequest,
  ViewPatch,
  ViewStreamAdapter,
} from "./types";

export function csdSnapshotToView(
  records: unknown[],
  context?: AdapterContext,
): SessionView {
  let view = createEmptySessionView(csdSessionSummary(context));
  view.cursor = context?.cursor ?? "";

  const adapter = createCsdViewAdapter(view, context);
  for (const record of records) {
    for (const patch of adapter.toPatches(record, context)) {
      view = applyViewPatch(view, patch);
    }
  }

  return view;
}

export function createCsdViewAdapter(
  initialView: SessionView,
  context?: AdapterContext,
): ViewStreamAdapter {
  let view = initialView;
  let nextGeneratedId = initialView.items.length + 1;

  return {
    toPatches(nativeEvent: unknown, ctx?: AdapterContext): ViewPatch[] {
      const event = asRecord(nativeEvent);
      if (!event) return [];

      const patches = csdEventToPatches(event, {
        context: ctx ?? context,
        nextId(prefix) {
          return `${prefix}-${nextGeneratedId++}`;
        },
      });

      for (const patch of patches) {
        view = applyViewPatch(view, patch);
      }
      return patches;
    },
  };
}

type PatchContext = {
  context?: AdapterContext;
  nextId: (prefix: string) => string;
};

function csdEventToPatches(
  event: Record<string, unknown>,
  patchContext: PatchContext,
): ViewPatch[] {
  const kind = observationKind(event);
  switch (kind) {
    case "prompt":
      return [{ type: "appendItem", item: userMessageItem(event, patchContext) }];
    case "start":
      return [{ type: "setStatus", status: "running", statusText: statusText(event, "Running") }];
    case "assistant":
      return [{ type: "appendItem", item: assistantMessageItem(event, patchContext) }];
    case "stop":
      return [{ type: "setStatus", status: "idle", statusText: statusText(event, "Idle") }];
    case "timeout":
    case "error":
      return [{ type: "setStatus", status: "failed", statusText: statusText(event, errorText(event)) }];
    case "user_stop":
      return [{ type: "setStatus", status: "stopped", statusText: statusText(event, "Stopped") }];
    case "blocked":
      return blockedPatches(event, patchContext);
    case "cursor":
      return cursorPatch(event);
    default:
      return [];
  }
}

type ObservationKind =
  | "prompt"
  | "start"
  | "assistant"
  | "stop"
  | "timeout"
  | "error"
  | "user_stop"
  | "blocked"
  | "cursor"
  | "unknown";

function observationKind(event: Record<string, unknown>): ObservationKind {
  const type = lower(firstString(event.type, event.kind, event.event, event.hook));
  const phase = lower(firstString(event.phase, event.status));

  if (type === "prompt_submitted" || type === "prompt" || type === "user_prompt" || type === "user_message") {
    return "prompt";
  }
  if (type === "worker_started" || type === "turn_started" || type === "start" || type === "accepted") {
    return "start";
  }
  if (
    type === "assistant_final" ||
    type === "assistant_message" ||
    type === "final_assistant_text" ||
    type === "turn_completed" ||
    type === "result"
  ) {
    return "assistant";
  }
  if (type === "stop" || type === "stop_hook" || type === "hook_stop") {
    if (lower(firstString(event.reason)) === "user" || lower(firstString(event.outcome)) === "user_stop") {
      return "user_stop";
    }
    if (phase === "error" || phase === "failed") return "error";
    return "stop";
  }
  if (type === "timeout" || phase === "timeout") return "timeout";
  if (type === "driver_error" || type === "error" || phase === "error" || phase === "failed") return "error";
  if (type === "user_stop" || type === "stopped" || phase === "stopped") return "user_stop";
  if (
    type === "interactive_prompt" ||
    type === "permission_request" ||
    type === "input_request" ||
    type === "blocked" ||
    phase === "blocked"
  ) {
    return "blocked";
  }
  if (type === "cursor") return "cursor";

  return "unknown";
}

function userMessageItem(
  event: Record<string, unknown>,
  patchContext: PatchContext,
): UserMessageItem {
  const text = firstString(event.prompt, event.message, event.text, event.content);
  return {
    kind: "user",
    id: stableId(event, patchContext, "csd-user"),
    content: [{ type: "text", text }],
    timestamp: timestamp(event),
  };
}

function assistantMessageItem(
  event: Record<string, unknown>,
  patchContext: PatchContext,
): AssistantMessageItem {
  const text = firstString(
    event.finalText,
    event.assistantText,
    event.text,
    event.message,
    event.content,
    nestedString(event.result, "text"),
    nestedString(event.result, "content"),
  );
  return {
    kind: "assistant",
    id: stableId(event, patchContext, "csd-assistant"),
    content: [{ type: "text", text }],
    provider: firstString(event.provider) || undefined,
    model: firstString(event.model) || undefined,
    timestamp: timestamp(event),
  };
}

function blockedPatches(
  event: Record<string, unknown>,
  patchContext: PatchContext,
): ViewPatch[] {
  const method = firstString(event.method, event.promptType, event.requestType) || "csd.interactive";
  const request: UserRequest = {
    id: stableId(event, patchContext, "csd-request"),
    method,
    params: {
      message: firstString(event.message, event.text, event.label) || "CSD is waiting for input",
    },
  };
  return [
    { type: "setPendingRequest", request },
    { type: "setStatus", status: "blocked", statusText: statusText(event, "Waiting for input") },
  ];
}

function cursorPatch(event: Record<string, unknown>): ViewPatch[] {
  const cursor = firstString(event.cursor, event.eventId, event.id);
  return cursor ? [{ type: "setCursor", cursor }] : [];
}

function csdSessionSummary(context?: AdapterContext): SessionSummary {
  const base = context?.session ?? {
    id: "",
    title: "CSD session",
    status: "idle" as const,
  };
  return {
    ...base,
    metadata: {
      ...base.metadata,
      runner: typeof base.metadata?.runner === "string" ? base.metadata.runner : "csd",
    },
  };
}

function stableId(
  event: Record<string, unknown>,
  patchContext: PatchContext,
  prefix: string,
): string {
  return firstString(event.id, event.eventId, event.messageId, event.uuid) || patchContext.nextId(prefix);
}

function statusText(event: Record<string, unknown>, fallback: string): string {
  return firstString(event.statusText, event.message, event.text, event.error) || fallback;
}

function errorText(event: Record<string, unknown>): string {
  return statusText(event, "CSD runner failed");
}

function timestamp(event: Record<string, unknown>): number | undefined {
  const value = event.timestamp ?? event.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function nestedString(value: unknown, key: string): string {
  const record = asRecord(value);
  return firstString(record?.[key]);
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
