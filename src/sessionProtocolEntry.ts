/**
 * Protocol-only entrypoint for node/browser consumers that need the
 * Session View protocol types and Pi adapter without pulling in Vue UI,
 * CSS, or server-only modules.
 *
 * Import as: @shishberg/agent-web/session-protocol
 *
 * This module must NOT import from ../src/index, ../src/App.vue, or any
 * server module.  Its dependency tree is limited to:
 *   src/protocol/types.ts
 *   src/protocol/view-reducer.ts
 *   src/protocol/pi-adapter.ts
 */
export {
  applyViewPatch,
  assertNoRawPiRecords,
  assertValidSessionView,
  createCsdViewAdapter,
  createEmptySessionView,
  createPiViewAdapter,
  csdSnapshotToView,
  piSnapshotToView,
  piStreamEventToPatch,
} from "./protocol";
export type {
  AdapterContext,
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
  ViewStreamAdapter,
} from "./protocol";
