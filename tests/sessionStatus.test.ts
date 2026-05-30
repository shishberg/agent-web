import { describe, expect, it } from "vitest";
import {
  connectionLabel,
  createInitialSessionStatus,
  reduceSessionStatusEvent,
  setConnected,
  setConnecting,
  setIdle,
  setRunning,
  setSessionListError,
  setSessionListLoaded,
  statusBadgeText,
  statusCssClass,
  type SessionStatusState,
} from "../src/lib/sessionStatus";
import type { SessionSummary, StreamEvent } from "../src/lib/sessionApi";

function streamEvent(
  type: StreamEvent["type"],
  payload: Record<string, unknown> = {},
  eventId = "evt-1",
): StreamEvent {
  return {
    type,
    sessionId: "s1",
    eventId,
    createdAt: new Date().toISOString(),
    payload,
  };
}

function initial(): SessionStatusState {
  return createInitialSessionStatus();
}

describe("session status model", () => {
  // ── initial state ──

  it("starts in idle with no connection", () => {
    const s = createInitialSessionStatus();
    expect(s.displayStatus).toBe("idle");
    expect(s.connected).toBe(false);
    expect(s.backendStatus).toBe("idle");
    expect(s.runnerStatus).toBe("");
    expect(s.turnActive).toBe(false);
    expect(s.errorMessage).toBe("");
    expect(statusBadgeText(s)).toBe("Disconnected");
    expect(statusCssClass(s)).toBe("idle");
    expect(connectionLabel(s)).toBe("Disconnected");
  });

  // ── lifecycle actions ──

  it("transitions to connected after session list loads", () => {
    const s = setSessionListLoaded(initial());
    expect(s.displayStatus).toBe("connected");
    expect(s.connected).toBe(true);
    expect(statusBadgeText(s)).toBe("Connected");
  });

  it("transitions to failed after session list error", () => {
    const s = setSessionListError(initial(), "network error");
    expect(s.displayStatus).toBe("failed");
    expect(s.connected).toBe(false);
    expect(s.errorMessage).toBe("network error");
    expect(s.statusText).toBe("Failed to list sessions: network error");
    expect(statusBadgeText(s)).toBe("Error");
    expect(statusCssClass(s)).toBe("error");
  });

  it("transitions to connecting", () => {
    const s = setConnecting(initial(), "Opening session");
    expect(s.displayStatus).toBe("connecting");
    expect(s.connected).toBe(true);
    expect(s.statusText).toBe("Opening session");
    expect(statusBadgeText(s)).toBe("Connecting");
    expect(statusCssClass(s)).toBe("connecting");
  });

  it("transitions to running", () => {
    const s = setRunning(initial(), "Starting Pi");
    expect(s.displayStatus).toBe("running");
    expect(statusBadgeText(s)).toBe("Running");
    expect(statusCssClass(s)).toBe("running");
  });

  // ── backend status events ──

  it("handles session.updated with running backend status", () => {
    const s = reduceSessionStatusEvent(
      initial(),
      streamEvent("session.updated", {
        session: { id: "s1", title: "Test", status: "running" } as SessionSummary,
      }),
    );
    expect(s.displayStatus).toBe("running");
    expect(s.backendStatus).toBe("running");
    expect(s.connected).toBe(true);
    expect(s.statusText).toBe("Pi running");
  });

  it("handles session.updated with failed backend status", () => {
    const s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("session.updated", {
        session: { id: "s1", title: "Test", status: "failed" } as SessionSummary,
      }),
    );
    expect(s.displayStatus).toBe("failed");
    expect(s.backendStatus).toBe("failed");
    expect(s.connected).toBe(false);
  });

  it("handles session.updated with stopped backend status", () => {
    const s = reduceSessionStatusEvent(
      setRunning(initial()),
      streamEvent("session.updated", {
        session: { id: "s1", title: "Test", status: "stopped" } as SessionSummary,
      }),
    );
    expect(s.displayStatus).toBe("stopped");
    expect(s.backendStatus).toBe("stopped");
    expect(s.connected).toBe(false);
    expect(s.statusText).toBe("Pi stopped");
  });

  it("handles session.updated with idle backend status — completes a running turn", () => {
    // Start running
    let s = setRunning(initial());
    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "agent_start" } }),
    );
    expect(s.displayStatus).toBe("running");

    // Backend marks idle → turn complete
    s = reduceSessionStatusEvent(
      s,
      streamEvent("session.updated", {
        session: { id: "s1", title: "Test", status: "idle" } as SessionSummary,
      }),
    );
    expect(s.displayStatus).toBe("connected");
    expect(s.backendStatus).toBe("idle");
    expect(s.turnActive).toBe(false);
    expect(s.statusText).toBe("Agent finished");
  });

  it("handles session.updated with blocked backend status", () => {
    const s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("session.updated", {
        session: { id: "s1", title: "Test", status: "blocked" } as SessionSummary,
      }),
    );
    expect(s.displayStatus).toBe("blocked");
    expect(s.backendStatus).toBe("blocked");
    expect(s.connected).toBe(true);
  });

  it("handles session.updated with unknown status gracefully", () => {
    // Simulate a status value that falls outside the known union —
    // e.g. from a newer backend version.  The reducer should handle it
    // without crashing.
    const event = streamEvent("session.updated", {
      session: { id: "s1", title: "Test", status: "suspended" },
    });
    const s = reduceSessionStatusEvent(setConnected(initial()), event);
    expect(s.backendStatus).toBe("suspended");
    expect(s.displayStatus).toBe("connected"); // unchanged
  });

  // ── pi.status events ──

  it("handles pi.status starting → connecting", () => {
    const s = reduceSessionStatusEvent(
      initial(),
      streamEvent("pi.status", { status: "starting" }),
    );
    expect(s.displayStatus).toBe("connecting");
    expect(s.runnerStatus).toBe("starting");
    expect(s.connected).toBe(true);
    expect(s.statusText).toBe("Pi starting");
  });

  it("handles pi.status running → running", () => {
    const s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("pi.status", { status: "running" }),
    );
    expect(s.displayStatus).toBe("running");
    expect(s.runnerStatus).toBe("running");
    expect(s.connected).toBe(true);
    expect(s.statusText).toBe("Pi running");
  });

  it("handles pi.status exited → stopped", () => {
    const s = reduceSessionStatusEvent(
      setRunning(initial()),
      streamEvent("pi.status", { status: "exited" }),
    );
    expect(s.displayStatus).toBe("stopped");
    expect(s.runnerStatus).toBe("exited");
    expect(s.connected).toBe(false);
    expect(s.statusText).toBe("Pi exited");
  });

  it("keeps failed display status after pi.status exited when previously in error", () => {
    const s = reduceSessionStatusEvent(
      reduceSessionStatusEvent(
        setConnected(initial()),
        streamEvent("error", { message: "crash" }),
      ),
      streamEvent("pi.status", { status: "exited" }),
    );
    expect(s.displayStatus).toBe("failed");
    expect(s.runnerStatus).toBe("exited");
  });

  // ── pi.event agent lifecycle ──

  it("handles agent_start → running", () => {
    const s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("pi.event", { event: { type: "agent_start" } }),
    );
    expect(s.displayStatus).toBe("running");
    expect(s.turnActive).toBe(true);
    expect(s.statusText).toBe("Agent running");
  });

  it("handles agent_end → connected", () => {
    let s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("pi.event", { event: { type: "agent_start" } }),
    );
    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "agent_end" } }),
    );
    expect(s.displayStatus).toBe("connected");
    expect(s.turnActive).toBe(false);
    expect(s.statusText).toBe("Agent finished");
  });

  it("handles agent_end while blocked → stays blocked", () => {
    let s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("session.updated", {
        session: { id: "s1", title: "Test", status: "blocked" } as SessionSummary,
      }),
    );
    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "agent_end" } }),
    );
    expect(s.displayStatus).toBe("blocked");
    expect(s.turnActive).toBe(false);
  });

  it("handles turn_start and turn_end", () => {
    let s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("pi.event", { event: { type: "turn_start" } }),
    );
    expect(s.turnActive).toBe(true);

    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "turn_end" } }),
    );
    expect(s.turnActive).toBe(false);
  });

  // ── error events ──

  it("handles stream error events → failed", () => {
    const s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("error", { message: "connection lost" }),
    );
    expect(s.displayStatus).toBe("failed");
    expect(s.connected).toBe(false);
    expect(s.errorMessage).toBe("connection lost");
    expect(s.statusText).toBe("connection lost");
    expect(statusBadgeText(s)).toBe("Error");
  });

  it("handles error event without message gracefully", () => {
    const s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("error", {}),
    );
    expect(s.displayStatus).toBe("failed");
    expect(s.statusText).toBe("Stream error");
  });

  // ── user_request.created (extension requests) ──

  it("transitions to blocked when user_request arrives during running", () => {
    const s = reduceSessionStatusEvent(
      setRunning(initial()),
      streamEvent("user_request.created", {
        request: { id: "req-1", method: "confirm" },
      }),
    );
    expect(s.displayStatus).toBe("blocked");
  });

  it("does not change status on user_request when not running", () => {
    const s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("user_request.created", {
        request: { id: "req-1", method: "confirm" },
      }),
    );
    expect(s.displayStatus).toBe("connected");
  });

  // ── extension_ui_request via pi.event ──

  it("handles blocking extension request via pi.event → blocked", () => {
    const s = reduceSessionStatusEvent(
      setRunning(initial()),
      streamEvent("pi.event", {
        event: { type: "extension_ui_request", method: "confirm", id: "ext-1" },
      }),
    );
    expect(s.displayStatus).toBe("blocked");
  });

  it("handles fire-and-forget set_editor_text → status text update", () => {
    const s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("pi.event", {
        event: { type: "extension_ui_request", method: "set_editor_text" },
      }),
    );
    expect(s.statusText).toBe("Editor text updated");
    expect(s.displayStatus).toBe("connected");
  });

  it("handles fire-and-forget setStatus → status text update", () => {
    const s = reduceSessionStatusEvent(
      setConnected(initial()),
      streamEvent("pi.event", {
        event: {
          type: "extension_ui_request",
          method: "setStatus",
          params: { statusText: "Indexing files" },
        },
      }),
    );
    expect(s.statusText).toBe("Indexing files");
    expect(s.displayStatus).toBe("connected");
  });

  // ── compaction / auto-retry (via pi.event) ──

  it("updates status text for compaction lifecycle", () => {
    let s = reduceSessionStatusEvent(
      setRunning(initial()),
      streamEvent("pi.event", { event: { type: "compaction_start" } }),
    );
    expect(s.statusText).toBe("Compacting session");

    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "compaction_end" } }),
    );
    expect(s.statusText).toBe("Compaction complete");
  });

  it("updates status text for auto_retry lifecycle", () => {
    let s = reduceSessionStatusEvent(
      setRunning(initial()),
      streamEvent("pi.event", { event: { type: "auto_retry_start" } }),
    );
    expect(s.statusText).toBe("Auto retry running");

    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "auto_retry_end" } }),
    );
    expect(s.statusText).toBe("Auto retry finished");
  });

  it("handles extension_error via pi.event", () => {
    let s = setRunning(initial());
    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", {
        event: { type: "extension_error", message: "permission denied" },
      }),
    );
    expect(s.statusText).toBe("permission denied");
  });

  // ── full lifecycle transitions ──

  it("completes full lifecycle: idle → connected → running → completed → idle", () => {
    let s = initial();
    expect(s.displayStatus).toBe("idle");
    expect(statusBadgeText(s)).toBe("Disconnected");

    // Session list loads
    s = setSessionListLoaded(s);
    expect(s.displayStatus).toBe("connected");
    expect(statusBadgeText(s)).toBe("Connected");

    // Agent starts
    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "agent_start" } }),
    );
    expect(s.displayStatus).toBe("running");
    expect(statusBadgeText(s)).toBe("Running");

    // Agent ends → back to connected
    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "agent_end" } }),
    );
    expect(s.displayStatus).toBe("connected");
    expect(s.turnActive).toBe(false);
    expect(statusBadgeText(s)).toBe("Connected");
  });

  it("completes lifecycle with pi.status events: connecting → running → stopped", () => {
    let s = setConnecting(initial(), "Opening");

    // Runner starts
    s = reduceSessionStatusEvent(s, streamEvent("pi.status", { status: "starting" }));
    expect(s.displayStatus).toBe("connecting");

    // Runner running
    s = reduceSessionStatusEvent(s, streamEvent("pi.status", { status: "running" }));
    expect(s.displayStatus).toBe("running");
    expect(statusBadgeText(s)).toBe("Running");

    // Runner exits
    s = reduceSessionStatusEvent(s, streamEvent("pi.status", { status: "exited" }));
    expect(s.displayStatus).toBe("stopped");
    expect(s.connected).toBe(false);
    expect(statusBadgeText(s)).toBe("Stopped");
  });

  it("reconnects after a stop: stopped → connected", () => {
    let s = setRunning(initial());
    s = reduceSessionStatusEvent(s, streamEvent("pi.status", { status: "exited" }));
    expect(s.displayStatus).toBe("stopped");

    // Reconnect: list sessions again
    s = setSessionListLoaded(s);
    expect(s.displayStatus).toBe("connected");
    expect(s.connected).toBe(true);
    expect(statusBadgeText(s)).toBe("Connected");
  });

  it("transitions through blocked state from running with extension request", () => {
    let s = setConnected(initial());

    // Start running
    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "agent_start" } }),
    );
    expect(s.displayStatus).toBe("running");

    // Backend reports blocked
    s = reduceSessionStatusEvent(
      s,
      streamEvent("session.updated", {
        session: { id: "s1", title: "Test", status: "blocked" } as SessionSummary,
      }),
    );
    expect(s.displayStatus).toBe("blocked");

    // Agent ends while blocked
    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "agent_end" } }),
    );
    expect(s.displayStatus).toBe("blocked");
    expect(s.turnActive).toBe(false);

    // Backend unblocks
    s = reduceSessionStatusEvent(
      s,
      streamEvent("session.updated", {
        session: { id: "s1", title: "Test", status: "idle" } as SessionSummary,
      }),
    );
    expect(s.displayStatus).toBe("connected");
  });

  it("transitions: connected → running → failed → stopped (error then exit)", () => {
    let s = setConnected(initial());

    s = reduceSessionStatusEvent(
      s,
      streamEvent("pi.event", { event: { type: "agent_start" } }),
    );
    expect(s.displayStatus).toBe("running");

    // Error occurs
    s = reduceSessionStatusEvent(s, streamEvent("error", { message: "Pi crashed" }));
    expect(s.displayStatus).toBe("failed");
    expect(s.errorMessage).toBe("Pi crashed");
    expect(statusBadgeText(s)).toBe("Error");

    // Process exits
    s = reduceSessionStatusEvent(s, streamEvent("pi.status", { status: "exited" }));
    expect(s.displayStatus).toBe("failed"); // stays failed, not overwritten
    expect(s.runnerStatus).toBe("exited");
    expect(s.connected).toBe(false);
  });

  it("handles backend status failed alongside error event", () => {
    let s = setConnected(initial());

    // Error stream event
    s = reduceSessionStatusEvent(s, streamEvent("error", { message: "stream broken" }));
    expect(s.displayStatus).toBe("failed");
    expect(s.connected).toBe(false);

    // Backend also reports failed
    s = reduceSessionStatusEvent(
      s,
      streamEvent("session.updated", {
        session: { id: "s1", title: "Test", status: "failed" } as SessionSummary,
      }),
    );
    expect(s.displayStatus).toBe("failed");
    expect(s.backendStatus).toBe("failed");
  });

  // ── idle action (new chat / reset) ──

  it("resets to idle with custom status text", () => {
    let s = setRunning(initial());
    s = setIdle(s, "Ready for new chat");
    expect(s.displayStatus).toBe("idle");
    expect(s.connected).toBe(true);
    expect(s.runnerStatus).toBe("");
    expect(s.turnActive).toBe(false);
    expect(s.statusText).toBe("Ready for new chat");
    expect(statusBadgeText(s)).toBe("Ready");
  });

  // ── snapshot status derivation when opening a saved session ──

  it("derives status from snapshot backend status rather than always falling back to connected", () => {
    // Simulate opening an active (running) session
    let s = setConnecting(initial(), "Opening session");
    expect(s.displayStatus).toBe("connecting");

    // Snapshot says the session is running
    s = reduceSessionStatusEvent(s, streamEvent("session.updated", {
      session: { id: "s1", title: "Active", status: "running" } as SessionSummary,
    }));
    expect(s.displayStatus).toBe("running");
    expect(s.backendStatus).toBe("running");
  });

  it("falls back to connected when snapshot is idle and no events upgrade status", () => {
    // Simulate opening an idle session — should end up connected
    let s = setConnecting(initial(), "Opening session");

    s = reduceSessionStatusEvent(s, streamEvent("session.updated", {
      session: { id: "s1", title: "Idle", status: "idle" } as SessionSummary,
    }));
    // Idle backend → connected display
    expect(s.displayStatus).toBe("connected");
  });

  // ── connection label helper ──

  it("returns correct connection labels for every display status", () => {
    expect(connectionLabel({ ...initial(), displayStatus: "idle", connected: false })).toBe("Disconnected");
    expect(connectionLabel({ ...initial(), displayStatus: "idle", connected: true })).toBe("Connected (idle)");
    expect(connectionLabel({ ...initial(), displayStatus: "connected" })).toBe("Connected");
    expect(connectionLabel({ ...initial(), displayStatus: "connecting" })).toBe("Connecting");
    expect(connectionLabel({ ...initial(), displayStatus: "running" })).toBe("Pi running");
    expect(connectionLabel({ ...initial(), displayStatus: "blocked" })).toBe("Waiting for input");
    expect(connectionLabel({ ...initial(), displayStatus: "failed" })).toBe("Error");
    expect(connectionLabel({ ...initial(), displayStatus: "stopped" })).toBe("Stopped");
  });

  // ── status badge text ──

  it("returns correct badge text for all display statuses", () => {
    // idle + disconnected → "Disconnected"
    expect(statusBadgeText({ ...initial(), displayStatus: "idle", connected: false })).toBe("Disconnected");
    // idle + connected → "Ready"
    expect(statusBadgeText({ ...initial(), displayStatus: "idle", connected: true })).toBe("Ready");
    expect(statusBadgeText({ ...initial(), displayStatus: "connected" })).toBe("Connected");
    expect(statusBadgeText({ ...initial(), displayStatus: "connecting" })).toBe("Connecting");
    expect(statusBadgeText({ ...initial(), displayStatus: "running" })).toBe("Running");
    expect(statusBadgeText({ ...initial(), displayStatus: "blocked" })).toBe("Input needed");
    expect(statusBadgeText({ ...initial(), displayStatus: "failed" })).toBe("Error");
    expect(statusBadgeText({ ...initial(), displayStatus: "stopped" })).toBe("Stopped");
  });

  // ── status CSS class ──

  it("returns the display status as css class name", () => {
    expect(statusCssClass({ ...initial(), displayStatus: "running" })).toBe("running");
    expect(statusCssClass({ ...initial(), displayStatus: "connected" })).toBe("connected");
  });

  it("maps failed display status to 'error' css class", () => {
    expect(statusCssClass({ ...initial(), displayStatus: "failed" })).toBe("error");
  });
});
