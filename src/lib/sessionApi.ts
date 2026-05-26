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
	messages: unknown[];
	state?: Record<string, unknown>;
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

	subscribeToSession(
		sessionId: string,
		onEvent: (event: StreamEvent) => void,
		opts?: { cursor?: string },
	): Unsubscribe;
	subscribeToSessionList(
		onUpdate: (sessions: SessionSummary[]) => void,
	): Unsubscribe;
};
