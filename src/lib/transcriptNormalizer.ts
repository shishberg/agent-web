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
