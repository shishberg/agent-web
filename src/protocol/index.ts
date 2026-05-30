/**
 * Protocol barrel: re-exports all Session View protocol types and utilities
 * from a single entrypoint.
 *
 * This module is UI-agnostic: no Vue, DOM, browser transport, server, or
 * Verandah imports.  It can be imported by any consumer without pulling in
 * App.vue or browser CSS.
 */
export type {
  AssistantMessageItem,
  BaseItem,
  ContentBlock,
  ConversationItem,
  RunStatus,
  SessionSummary,
  SessionView,
  SystemNoticeItem,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolItem,
  ToolResultBlock,
  UsageInfo,
  UserMessageItem,
  UserRequest,
  ViewPatch,
} from "./types";
export { createEmptySessionView } from "./types";
export { assertNoRawPiRecords, assertValidSessionView } from "./contract";
export { applyViewPatch } from "./view-reducer";
export { piSnapshotToView, piStreamEventToPatch } from "./pi-adapter";
