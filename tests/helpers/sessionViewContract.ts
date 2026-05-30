import {
  assertNoRawPiRecords,
  assertValidSessionView,
  type SessionView,
} from "../../src/sessionProtocolEntry";

export function expectValidSessionView(view: unknown): asserts view is SessionView {
  assertValidSessionView(view);
}

export function expectNoRawPiRecords(view: unknown): void {
  assertNoRawPiRecords(view);
}
