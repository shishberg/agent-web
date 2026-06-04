// ── Session View Protocol types ──
//
// These types define the stable view contract between any backend and the UI.
// They are UI-agnostic: no Vue, DOM, browser transport, server, or Verandah
// imports.  The UI renders a SessionView and reacts to ViewPatch deltas.  Every
// backend adapts its internal model into these types.

// ── Run status ──

export type RunStatus =
  | "idle"
  | "connected"
  | "connecting"
  | "running"
  | "blocked"
  | "failed"
  | "stopped";

// ── Session summary ──

export type SessionSummary = {
  id: string;
  title: string;
  status: RunStatus;
  kind?: string;
  createdAt?: string;
  updatedAt?: string;
  sessionPath?: string;
  metadata?: Record<string, unknown>;
};

// ── Content blocks ──

export type TextBlock = {
  type: "text";
  text: string;
};

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
};

export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
};

/**
 * Union of content blocks that make up a message body.
 * Additional block types may be added by backends; the UI should gracefully
 * handle unknown shapes.
 */
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown };

// ── Conversation items ──

export type BaseItem = {
  /** Stable, unique id for this item within the session view. */
  id: string;
  /** Epoch millis when the item was created. */
  timestamp?: number;
};

export type UserMessageItem = BaseItem & {
  kind: "user";
  content: ContentBlock[];
};

export type UsageInfo = {
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
};

export type AssistantToolPart = {
  id: string;
  name: string;
  label: string;
  input?: unknown;
  detail?: string;
  output?: unknown;
  content?: string;
  status: "pending" | "running" | "done" | "error";
};

export type AssistantMessageItem = BaseItem & {
  kind: "assistant";
  content: ContentBlock[];
  /** Thinking / reasoning blocks, rendered in a collapsible panel. */
  thinking?: ContentBlock[];
  tools?: AssistantToolPart[];
  provider?: string;
  model?: string;
  usage?: UsageInfo;
};

export type ToolItem = BaseItem & {
  kind: "tool";
  toolName: string;
  toolLabel: string;
  detail?: string;
  input: unknown;
  output: unknown;
  status: "running" | "done" | "error";
};

export type SystemNoticeItem = BaseItem & {
  kind: "notice";
  text: string;
  noticeType: "compaction" | "retry" | "model_change" | "info";
};

export type ConversationItem =
  | UserMessageItem
  | AssistantMessageItem
  | ToolItem
  | SystemNoticeItem;

// ── User request ──

export type UserRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

// ── SessionView ──

/**
 * The full session view model.  Produced by the backend adapter for
 * snapshots; the UI hydrates from it directly.
 */
export type SessionView = {
  session: SessionSummary;
  items: ConversationItem[];
  status: RunStatus;
  statusText: string;
  pendingRequests: UserRequest[];
  extensionDraft: string | null;
  cursor: string;
};

// ── ViewPatch ──

/**
 * Stream deltas.  A sequence of these, applied to a SessionView, produces
 * the next state.  The UI applies patches as they arrive and re-renders.
 */
export type ViewPatch =
  | { type: "appendItem"; item: ConversationItem }
  | { type: "updateItem"; id: string; partial: Partial<ConversationItem> }
  | { type: "upsertAssistantTool"; assistantId: string; tool: Partial<AssistantToolPart> & { id: string } }
  | { type: "setStatus"; status: RunStatus; statusText?: string }
  | { type: "setPendingRequest"; request: UserRequest }
  | { type: "clearPendingRequest"; id: string }
  | { type: "setExtensionDraft"; text: string }
  | { type: "setCursor"; cursor: string }
  | { type: "setSession"; session: SessionSummary };

// ── Adapter types ──

/**
 * Context passed to snapshot and stream adapters to supply runner-level
 * metadata that the raw native records cannot provide.
 */
export type AdapterContext = {
  session?: SessionSummary;
  cursor?: string;
  now?: () => Date;
};

/**
 * A stateful view-stream adapter created by a runner adapter factory.
 *
 * Each stream subscription should create its own adapter instance.
 * The adapter may keep internal stream state (e.g. accumulated deltas)
 * across calls to {@link toPatches}.
 */
export type ViewStreamAdapter = {
  /**
   * Convert one native runner event into zero or more ViewPatch values.
   *
   * The adapter MUST NOT mutate the incoming event object.
   * The adapter MUST NOT perform I/O (file, network, database).
   */
  toPatches(nativeEvent: unknown, context?: AdapterContext): ViewPatch[];
};

// ── Factory helpers ──

export function createEmptySessionView(
  session: SessionSummary = {
    id: "",
    title: "New session",
    status: "idle",
  },
): SessionView {
  return {
    session,
    items: [],
    status: "idle",
    statusText: "Ready",
    pendingRequests: [],
    extensionDraft: null,
    cursor: "",
  };
}
