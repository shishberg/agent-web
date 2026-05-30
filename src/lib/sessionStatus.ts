import type { SessionSummary, StreamEvent } from "./sessionApi";

/**
 * Canonical display status derived from backend lifecycle, runner state,
 * turn state, and error state.
 */
export type SessionDisplayStatus =
  | "idle"        // No active session, no runner
  | "connected"   // Session open, runner idle
  | "connecting"  // Runner starting / session opening
  | "running"     // Agent actively processing
  | "blocked"     // Waiting for user input (extension request)
  | "failed"      // Error state (recoverable or permanent)
  | "stopped";    // Runner exited / process stopped

/**
 * All status-related state in one place.  The UI reads display fields;
 * everything else is internal bookkeeping for the reducer.
 */
export type SessionStatusState = {
  /** Canonical display status derived from all inputs. */
  displayStatus: SessionDisplayStatus;

  /** Latest backend status from `SessionSummary.status`. */
  backendStatus: SessionSummary["status"];

  /** Latest runner status from `pi.status` events. */
  runnerStatus: string;

  /** True while an agent turn is in progress. */
  turnActive: boolean;

  /** True when the session manager connection is alive. */
  connected: boolean;

  /** Last error description, empty when not in an error state. */
  errorMessage: string;

  /** Human-readable detail suitable for the metadata dialog. */
  statusText: string;
};

export function createInitialSessionStatus(): SessionStatusState {
  return {
    displayStatus: "idle",
    backendStatus: "idle",
    runnerStatus: "",
    turnActive: false,
    connected: false,
    errorMessage: "",
    statusText: "Disconnected",
  };
}

// ── Lifecycle actions (UI-initiated transitions) ──

export function setSessionListLoaded(state: SessionStatusState): SessionStatusState {
  return {
    ...state,
    displayStatus: "connected",
    connected: true,
    statusText: "Ready",
  };
}

export function setSessionListError(state: SessionStatusState, message: string): SessionStatusState {
  return {
    ...state,
    displayStatus: "failed",
    connected: false,
    errorMessage: message,
    statusText: `Failed to list sessions: ${message}`,
  };
}

export function setConnecting(state: SessionStatusState, statusText?: string): SessionStatusState {
  return {
    ...state,
    displayStatus: "connecting",
    connected: true,
    statusText: statusText ?? state.statusText,
  };
}

export function setConnected(state: SessionStatusState, statusText?: string): SessionStatusState {
  return {
    ...state,
    displayStatus: "connected",
    connected: true,
    statusText: statusText ?? state.statusText,
  };
}

export function setIdle(state: SessionStatusState, statusText?: string): SessionStatusState {
  return {
    ...state,
    displayStatus: "idle",
    connected: true,
    runnerStatus: "",
    turnActive: false,
    statusText: statusText ?? state.statusText,
  };
}

export function setRunning(state: SessionStatusState, statusText?: string): SessionStatusState {
  return {
    ...state,
    displayStatus: "running",
    connected: true,
    statusText: statusText ?? state.statusText,
  };
}

// ── Stream event reducer ──

/**
 * Derive the next status state from a {@link StreamEvent}.
 *
 * Call for every stream event the UI receives.  The returned state
 * replaces the previous one; this function is a pure reduction — it
 * does not mutate the input.
 */
export function reduceSessionStatusEvent(
  state: SessionStatusState,
  event: StreamEvent,
): SessionStatusState {
  switch (event.type) {
    case "session.updated": {
      const summary = event.payload?.session as SessionSummary | undefined;
      return reduceBackendStatus(state, summary);
    }
    case "pi.event": {
      const piEvent = event.payload?.event as Record<string, unknown> | undefined;
      if (!piEvent) return state;
      return reducePiEventType(state, piEvent);
    }
    case "pi.status": {
      const piStatus = (event.payload?.status as string) ?? "";
      return reducePiStatus(state, piStatus);
    }
    case "error": {
      const message = typeof event.payload?.message === "string"
        ? event.payload.message
        : "Stream error";
      return reduceError(state, message);
    }
    case "user_request.created": {
      // Extension requests mean Pi is blocked waiting for user input.
      return {
        ...state,
        displayStatus: state.displayStatus === "running" ? "blocked" : state.displayStatus,
      };
    }
    default:
      return state;
  }
}

// ── Sub-reducers ──

function reduceBackendStatus(
  state: SessionStatusState,
  summary?: SessionSummary,
): SessionStatusState {
  const next = summary?.status ?? state.backendStatus;

  switch (next) {
    case "running":
      return {
        ...state,
        displayStatus: "running",
        backendStatus: "running",
        connected: true,
        statusText: "Pi running",
      };
    case "failed":
      return {
        ...state,
        displayStatus: "failed",
        backendStatus: "failed",
        connected: false,
        statusText: state.errorMessage || "Pi failed",
      };
    case "stopped":
      return {
        ...state,
        displayStatus: "stopped",
        backendStatus: "stopped",
        connected: false,
        statusText: "Pi stopped",
      };
    case "idle":
      if (state.displayStatus === "running" || state.displayStatus === "blocked") {
        // A running turn has completed
        return {
          ...state,
          displayStatus: "connected",
          backendStatus: "idle",
          connected: true,
          turnActive: false,
          statusText: "Agent finished",
        };
      }
      return {
        ...state,
        displayStatus: "connected",
        backendStatus: "idle",
        connected: true,
      };
    case "blocked":
      return {
        ...state,
        displayStatus: "blocked",
        backendStatus: "blocked",
        connected: true,
      };
    default:
      return { ...state, backendStatus: next };
  }
}

function reducePiEventType(
  state: SessionStatusState,
  event: Record<string, unknown>,
): SessionStatusState {
  const type = typeof event.type === "string" ? event.type : "";

  switch (type) {
    case "agent_start":
      return {
        ...state,
        displayStatus: "running",
        turnActive: true,
        statusText: "Agent running",
      };
    case "agent_end":
      return {
        ...state,
        displayStatus: state.backendStatus === "blocked" ? "blocked" : "connected",
        turnActive: false,
        statusText: "Agent finished",
      };
    case "turn_start":
      return { ...state, turnActive: true };
    case "turn_end":
      return { ...state, turnActive: false };
    case "compaction_start":
      return { ...state, statusText: "Compacting session" };
    case "compaction_end":
      return { ...state, statusText: "Compaction complete" };
    case "auto_retry_start":
      return { ...state, statusText: "Auto retry running" };
    case "auto_retry_end":
      return { ...state, statusText: "Auto retry finished" };
    case "extension_error": {
      const errorMsg = typeof event.message === "string" ? event.message : "";
      return { ...state, statusText: errorMsg || "Extension error" };
    }
    case "extension_ui_request": {
      // Fire-and-forget extension notifications update status text
      const method = typeof event.method === "string" ? event.method : "";
      if (method === "set_editor_text") {
        return { ...state, statusText: "Editor text updated" };
      }
      if (["notify", "setStatus", "setWidget", "setTitle"].includes(method)) {
        const params = typeof event.params === "object" && event.params !== null
          ? (event.params as Record<string, unknown>)
          : undefined;
        const text = typeof params?.statusText === "string"
          ? params.statusText
          : typeof params?.message === "string"
            ? params.message
            : typeof params?.status === "string"
              ? params.status
              : typeof params?.title === "string"
                ? params.title
                : method;
        return { ...state, statusText: text };
      }
      // Blocking extension request
      return {
        ...state,
        displayStatus: state.displayStatus === "running" ? "blocked" : state.displayStatus,
      };
    }
    default:
      return state;
  }
}

function reducePiStatus(
  state: SessionStatusState,
  status: string,
): SessionStatusState {
  const wasFailed = state.displayStatus === "failed";

  switch (status) {
    case "starting":
    case "connecting":
      return {
        ...state,
        displayStatus: "connecting",
        runnerStatus: status,
        connected: true,
        statusText: "Pi starting",
      };
    case "running":
      return {
        ...state,
        displayStatus: "running",
        runnerStatus: "running",
        connected: true,
        statusText: "Pi running",
      };
    case "exited":
      return {
        ...state,
        displayStatus: wasFailed ? "failed" : "stopped",
        runnerStatus: "exited",
        connected: false,
        statusText: wasFailed ? state.statusText : "Pi exited",
      };
    default:
      return { ...state, runnerStatus: status };
  }
}

function reduceError(
  state: SessionStatusState,
  message: string,
): SessionStatusState {
  return {
    ...state,
    displayStatus: "failed",
    connected: false,
    errorMessage: message,
    statusText: message,
  };
}

// ── Display helpers (pure functions of state) ──

/**
 * Short label for the status pill in the chat header.
 */
export function statusBadgeText(state: SessionStatusState): string {
  switch (state.displayStatus) {
    case "running":
      return "Running";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "blocked":
      return "Input needed";
    case "failed":
      return "Error";
    case "stopped":
      return "Stopped";
    case "idle":
    default:
      return state.connected ? "Ready" : "Disconnected";
  }
}

/**
 * CSS class name for the status pill element.
 */
export function statusCssClass(state: SessionStatusState): string {
  // Map failed to "error" to match existing .status-pill.error CSS.
  if (state.displayStatus === "failed") return "error";
  return state.displayStatus;
}

/**
 * Longer label for the metadata Connection field.
 */
export function connectionLabel(state: SessionStatusState): string {
  switch (state.displayStatus) {
    case "running":
      return "Pi running";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "blocked":
      return "Waiting for input";
    case "failed":
      return "Error";
    case "stopped":
      return "Stopped";
    case "idle":
    default:
      return state.connected ? "Connected (idle)" : "Disconnected";
  }
}
