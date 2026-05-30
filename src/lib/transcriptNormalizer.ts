/**
 * An event object emitted from a Pi stream (e.g. `message_start`,
 * `message_update`, `tool_execution_start`).
 *
 * The Pi stream often emits assistant lifecycle events whose nested
 * `message` object has no `message.id`.  This function synthesizes a
 * deterministic, stable `message.id` from known fields so downstream
 * consumers (the UI reducer) never have to guess.
 *
 * ## Identity contract
 *
 * For any event that carries a `message` object with a `role`:
 *
 *  1. If `message.id` is present and non-empty, it is preserved as-is.
 *  2. Otherwise a deterministic, namespaced id is synthesized from the
 *     message role plus stable Pi fields: `responseId` and/or `timestamp`.
 *     Pi message lifecycle events carry the same timestamp across
 *     `message_start`, `message_update`, and `message_end` for the same
 *     message, and `responseId` ties events to a turn when it is present.
 *
 * The event is mutated in-place so callers can pass it straight through
 * to the reducer.  Returns the same event reference for chaining.
 *
 * @param event  A raw Pi stream event.  May be mutated.
 * @returns      The same event reference, with `message.id` guaranteed
 *               when the message object has a `role` and at least one
 *               fallback field is available.
 */
export function normalizeStreamEvent(event: Record<string, unknown>): Record<string, unknown> {
  const message = isRecord(event.message) ? event.message : undefined;
  if (!message) {
    return event;
  }

  const rawRole = message.role;
  if (typeof rawRole !== "string" || !rawRole) {
    return event;
  }

  if (typeof message.id === "string" && message.id) {
    return event;
  }

  const syntheticId = synthesizeStreamMessageId(rawRole, message);
  if (syntheticId) {
    message.id = syntheticId;
  }

  return event;
}

function synthesizeStreamMessageId(
  role: string,
  message: Record<string, unknown>,
): string | undefined {
  const timestamp = typeof message.timestamp === "number" ? String(message.timestamp) : "";
  const responseId = typeof message.responseId === "string" && message.responseId ? message.responseId : "";

  if (timestamp) {
    return `pi:${role}:timestamp:${timestamp}`;
  }
  if (responseId) {
    return `pi:${role}:response:${responseId}`;
  }

  return undefined;
}

/**
 * Normalize a transcript array into the frontend-ready message shape.
 *
 * Different backends may produce different snapshot formats:
 * - PiDirect `SessionManager.buildSessionContext()` returns clean AgentMessage[]
 *   objects with `role`, `content`, `id`, `timestamp`, etc. at the top level.
 * - Verandah / raw Pi session-file readers return session-file records of the
 *   form `{ type: "message", id: string, message: AgentMessage }` alongside
 *   metadata records like `{ type: "session" }` and `{ type: "model_change" }`.
 *
 * This function unwraps session-file message records, skips non-message
 * metadata records, and passes already-normalized message objects through
 * unchanged.  When unwrapping, the wrapper-level `id`, `responseId`, and
 * `timestamp` are preserved as fallbacks when the inner message lacks them.
 * The output is always an array of message objects suitable for direct
 * consumption by the UI hydration path.
 *
 * Output shape (each element):
 *   { role: "user" | "assistant" | "system",
 *     content: string | ContentBlock[],
 *     id?: string,
 *     timestamp?: number,
 *     provider?: string,
 *     model?: string,
 *     ... }
 */
export function normalizeTranscript(messages: unknown[]): unknown[] {
  const normalized: unknown[] = [];

  for (const record of messages) {
    if (!isRecord(record)) {
      continue;
    }

    // Session-file message record: { type: "message", message: { role, content, ... } }
    // Preserve wrapper-level id / responseId / timestamp as fallbacks when the inner
    // message lacks them.  The Pi session-file record id is stable and many inner
    // messages (especially from older session files) do not carry their own id.
    if (record.type === "message" && isRecord(record.message)) {
      const wrapped = { ...record.message };
      if (!("id" in wrapped) && "id" in record) {
        wrapped.id = record.id;
      }
      if (!("responseId" in wrapped) && "responseId" in record) {
        wrapped.responseId = record.responseId;
      }
      if (!("timestamp" in wrapped) && "timestamp" in record) {
        wrapped.timestamp = record.timestamp;
      }
      normalized.push(wrapped);
      continue;
    }

    // Metadata records with a type field that isn't "message" and no role field
    // (e.g. { type: "session" }, { type: "model_change" }) are skipped.
    if (typeof record.type === "string" && record.type !== "message" && !record.role) {
      continue;
    }

    // Already a frontend-ready message object or unrecognized shape — pass through.
    normalized.push(record);
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
