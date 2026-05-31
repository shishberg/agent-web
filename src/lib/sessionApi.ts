import type { SessionView } from "../protocol/types";

export type SessionManagerCapabilities = {
	createSession: boolean;
	deleteSession: boolean;
	stopSession: boolean;
	setSessionMetadata: boolean;
	sendMessage: boolean;
	respondToUserRequest: boolean;
	backgroundSessions: boolean;
	sessionKind?: string[];
	metadata?: Record<string, unknown>;
};

export type Unsubscribe = () => void;

export type SessionSummary = {
	id: string;
	title: string;
	status: "idle" | "running" | "blocked" | "failed" | "stopped";
	kind?: "manual" | "task" | string;
	createdAt?: string;
	updatedAt?: string;
	sessionPath?: string;
	metadata?: Record<string, unknown>;
};

export type CreateSessionArgs = {
	prompt?: string;
	title?: string;
	kind?: string;
	cwd?: string;
	projectId?: string;
	workflowPath?: string;
	provider?: string;
	model?: string;
	profile?: string;
	metadata?: Record<string, unknown>;
};

export type SessionSnapshot = {
	session: SessionSummary;
	/**
	 * Typed session view model ready for UI hydration.
	 *
	 * Produced by the backend adapter via {@link piSnapshotToView}.
	 * The UI hydrates from this directly — no raw session-file records
	 * or untyped message arrays should cross this boundary.
	 */
	view: SessionView;
	state?: Record<string, unknown>;
	/**
	 * Opaque stream position recorded after the last event included in this
	 * snapshot.  Pass this value as the `cursor` option to
	 * {@link SessionManager.subscribeToSession} so the live stream resumes
	 * after the hydrated transcript instead of replaying events that are
	 * already represented in `view`.
	 *
	 * An empty string means the snapshot has no stream position (e.g. the
	 * session has never produced live events).
	 */
	streamCursor: string;
	metadata?: Record<string, unknown>;
};

export type SendResult = {
	queued: boolean;
	messageId?: string;
};

export type StreamEventType =
	| "session.created"
	| "session.updated"
	| "session.list.updated"
	| "view.patch"
	| "native.event"
	| "pi.event"
	| "pi.response"
	| "pi.status"
	| "pi.stderr"
	| "user_request.created"
	| "error";

export type StreamEvent = {
	type: StreamEventType;
	sessionId?: string;
	eventId: string;
	createdAt: string;
	payload: Record<string, unknown>;
};

export type UserRequestResponse = {
	id: string;
	cancelled?: boolean;
	confirmed?: boolean;
	value?: unknown;
};

export type SessionManager = {
	capabilities: SessionManagerCapabilities;

	listSessions(query?: {
		status?: string;
		kind?: string;
	}): Promise<SessionSummary[]>;
	createSession(args: CreateSessionArgs): Promise<SessionSummary>;
	deleteSession(id: string, opts?: { force?: boolean }): Promise<void>;

	openSession(id: string): Promise<SessionSnapshot>;

	sendMessage(
		sessionId: string,
		message: string,
		opts?: { mode?: "steer" | "followUp" },
	): Promise<SendResult>;
	stopSession(sessionId: string): Promise<void>;
	respondToUserRequest(
		sessionId: string,
		response: UserRequestResponse,
	): Promise<void>;

	/**
	 * Subscribe to live stream events for a session.
	 *
	 * @param opts.cursor - Opaque stream position.  Events with an id
	 *   at or before this cursor are suppressed so the stream only
	 *   delivers events that happened after the snapshot returned by
	 *   {@link openSession}.  Set this to
	 *   {@link SessionSnapshot.streamCursor} to avoid duplicate events
	 *   after hydrating a snapshot.
	 */
	subscribeToSession(
		sessionId: string,
		onEvent: (event: StreamEvent) => void,
		opts?: { cursor?: string },
	): Unsubscribe;
	subscribeToSessionList(
		onUpdate: (sessions: SessionSummary[]) => void,
	): Unsubscribe;

	/**
	 * Open a session snapshot and subscribe to its live event stream in a
	 * single operation.  Equivalent to calling {@link openSession} followed
	 * by {@link subscribeToSession} with the snapshot's
	 * {@link SessionSnapshot.streamCursor}, but guarantees the cursor
	 * handoff is never missed so the stream never replays events already
	 * represented in the snapshot.
	 */
	openAndSubscribeSession(
		id: string,
		onEvent: (event: StreamEvent) => void,
	): Promise<{ snapshot: SessionSnapshot; unsubscribe: Unsubscribe }>;
};
