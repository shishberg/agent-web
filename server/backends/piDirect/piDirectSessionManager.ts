import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import {
	PiRunnerCore,
	type DisconnectBehavior,
	type PersistedSessionReader,
	type PiRunnerCoreOptions,
} from "../../runnerCore";
import { listPiSessions, type PiSessionSummary } from "../../piSessions";
import { piSnapshotToView } from "../../../src/protocol/pi-adapter";
import type {
	CreateSessionArgs,
	SessionManager,
	SessionManagerCapabilities,
	SessionSnapshot,
	SessionSummary,
	SendResult,
	StreamEvent,
	Unsubscribe,
	UserRequestResponse,
} from "../../../src/lib/sessionApi";

export type PiDirectSessionManagerOptions = {
	cwd: string;
	sessionDir?: string;
	createPiProcess?: PiRunnerCoreOptions["createPiProcess"];
	listSessions?: (
		cwd: string,
		sessionDir?: string,
	) => Promise<PiSessionSummary[]>;
	openSession?: (path: string, sessionDir?: string) => PersistedSessionReader;
	disconnectBehavior?: DisconnectBehavior;
};

type SessionRecord = {
	id: string;
	title: string;
	status: SessionSummary["status"];
	kind?: string;
	createdAt: string;
	updatedAt: string;
	sessionPath?: string;
	runnerKey?: string;
	metadata: Record<string, unknown>;
	messages: unknown[];
	state?: Record<string, unknown>;
	streamCursor: string;
	creationArgs?: CreateSessionArgs;
};

type PendingCreation = {
	runnerKey: string;
	resolve: (summary: SessionSummary) => void;
	reject: (error: Error) => void;
	creationArgs?: CreateSessionArgs;
	draftId?: string;
};

export class PiDirectSessionManager implements SessionManager {
	readonly capabilities: SessionManagerCapabilities = {
		createSession: true,
		deleteSession: false,
		stopSession: true,
		setSessionMetadata: false,
		sendMessage: true,
		respondToUserRequest: true,
		backgroundSessions: false,
	};

	private readonly core: PiRunnerCore;
	private readonly cwd: string;
	private readonly sessionDir: string | undefined;
	private readonly listSessionsFn: (
		cwd: string,
		sessionDir?: string,
	) => Promise<PiSessionSummary[]>;
	private readonly openSessionFn: (
		path: string,
		sessionDir?: string,
	) => PersistedSessionReader;

	private readonly sessions = new Map<string, SessionRecord>();
	private readonly runnerKeyToId = new Map<string, string>();
	private readonly pathToId = new Map<string, string>();

	private readonly sessionSubscribers = new Map<
		string,
		Map<(event: StreamEvent) => void, string>
	>();
	private readonly listSubscribers = new Set<
		(sessions: SessionSummary[]) => void
	>();

	private readonly pendingCreates = new Map<string, PendingCreation>();

	private eventCounter = 0;
	private creationCounter = 0;
	private draftCounter = 0;

	constructor(options: PiDirectSessionManagerOptions) {
		this.cwd = options.cwd;
		this.sessionDir = options.sessionDir;
		this.listSessionsFn = options.listSessions ?? listPiSessions;
		this.openSessionFn =
			options.openSession ??
			((path, sessionDir) => PiSessionManager.open(path, sessionDir));

		this.core = new PiRunnerCore({
			cwd: options.cwd,
			sessionDir: options.sessionDir,
			createPiProcess: options.createPiProcess,
			listSessions: this.listSessionsFn,
			openSession: this.openSessionFn,
			disconnectBehavior: options.disconnectBehavior ?? "detach",
			send: (message, metadata) => this.routeCoreOutput(message, metadata),
		});
	}

	// ── SessionManager implementation ──

	async listSessions(query?: {
		status?: string;
		kind?: string;
	}): Promise<SessionSummary[]> {
		const summaries = await this.buildSessionList();
		return summaries.filter((s) => {
			if (query?.status && s.status !== query.status) {
				return false;
			}
			if (query?.kind && s.kind !== query.kind) {
				return false;
			}
			return true;
		});
	}

	async createSession(args: CreateSessionArgs): Promise<SessionSummary> {
		if (!args.prompt) {
			return this.createDraftSession(args);
		}

		return this.createSessionWithPrompt(args);
	}

	async deleteSession(_id: string, _opts?: { force?: boolean }): Promise<void> {
		throw new Error("deleteSession is not supported by the PiDirect backend.");
	}

	async openSession(id: string): Promise<SessionSnapshot> {
		const session = this.sessions.get(id);
		if (!session) {
			throw new Error(`Session not found: ${id}`);
		}

		if (!session.sessionPath) {
			throw new Error(`Session has no persisted file: ${id}`);
		}

		const persisted = this.openSessionFn(session.sessionPath, this.sessionDir);
		const context = persisted.buildSessionContext();
		session.messages = context.messages;
		session.state = {
			sessionId: persisted.getSessionId(),
			sessionFile: persisted.getSessionFile(),
			cwd: persisted.getCwd(),
			sessionName: persisted.getSessionName(),
			header: persisted.getHeader(),
		};

		const view = piSnapshotToView(session.messages);
		view.session = this.toSummary(session);

		return {
			session: this.toSummary(session),
			view,
			state: session.state,
			streamCursor: session.streamCursor,
			metadata: session.metadata,
		};
	}

	async sendMessage(
		sessionId: string,
		message: string,
		opts?: { mode?: "steer" | "followUp" },
	): Promise<SendResult> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		if (!session.sessionPath) {
			return this.activateDraftAndSend(session, message, opts);
		}

		// Ensure path-to-id mapping exists for routing
		this.pathToId.set(session.sessionPath, sessionId);

		const payload: Record<string, unknown> = {
			message,
			sessionPath: session.sessionPath,
		};
		if (opts?.mode === "followUp") {
			payload.queueMode = "followUp";
		}

		await this.core.handleClientMessage({
			type: "command",
			command: "prompt",
			payload,
		});
		return { queued: session.status === "running" };
	}

	async stopSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		if (session.runnerKey) {
			this.core.stopRunner(session.runnerKey);
		}

		if (session.sessionPath) {
			this.core.stopRunner(`path:${session.sessionPath}`);
		}

		session.status = "stopped";
		session.runnerKey = undefined;

		this.notifySessionListChanged();
	}

	async respondToUserRequest(
		sessionId: string,
		response: UserRequestResponse,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const payload: Record<string, unknown> = { ...response };
		if (session.sessionPath) {
			payload.sessionPath = session.sessionPath;
		} else if (session.runnerKey) {
			payload.internalRunnerKey = session.runnerKey;
		}

		await this.core.handleClientMessage({
			type: "command",
			command: "extension_ui_response",
			payload,
		});
	}

	subscribeToSession(
		sessionId: string,
		onEvent: (event: StreamEvent) => void,
		opts?: { cursor?: string },
	): Unsubscribe {
		const subscribers = this.sessionSubscribers.get(sessionId) ?? new Map();
		subscribers.set(onEvent, opts?.cursor ?? "");
		this.sessionSubscribers.set(sessionId, subscribers);

		return () => {
			subscribers.delete(onEvent);
			if (subscribers.size === 0) {
				this.sessionSubscribers.delete(sessionId);
			}
		};
	}

	async openAndSubscribeSession(
		id: string,
		onEvent: (event: StreamEvent) => void,
	): Promise<{ snapshot: SessionSnapshot; unsubscribe: Unsubscribe }> {
		const snapshot = await this.openSession(id);
		const unsubscribe = this.subscribeToSession(id, onEvent, {
			cursor: snapshot.streamCursor,
		});
		return { snapshot, unsubscribe };
	}

	subscribeToSessionList(
		onUpdate: (sessions: SessionSummary[]) => void,
	): Unsubscribe {
		this.listSubscribers.add(onUpdate);

		void this.buildSessionList().then((summaries) => {
			if (this.listSubscribers.has(onUpdate)) {
				onUpdate(summaries);
			}
		});

		return () => {
			this.listSubscribers.delete(onUpdate);
		};
	}

	dispose(): void {
		for (const [, pending] of this.pendingCreates) {
			pending.reject(new Error("Session manager disposed"));
		}
		this.pendingCreates.clear();

		this.core.dispose();
		this.sessions.clear();
		this.sessionSubscribers.clear();
		this.listSubscribers.clear();
	}

	// ── Private helpers ──

	private async createDraftSession(
		args: CreateSessionArgs,
	): Promise<SessionSummary> {
		const draftId = `draft-${++this.draftCounter}`;
		const now = new Date().toISOString();

		const record: SessionRecord = {
			id: draftId,
			title: args.title || "New session",
			status: "idle",
			kind: args.kind,
			createdAt: now,
			updatedAt: now,
			metadata: this.collectMetadata(args),
			messages: [],
			streamCursor: "",
			creationArgs: args,
		};

		this.sessions.set(draftId, record);
		this.notifySessionListChanged();
		return this.toSummary(record);
	}

	private async createSessionWithPrompt(
		args: CreateSessionArgs,
	): Promise<SessionSummary> {
		const runnerKey = `create-${++this.creationCounter}`;

		const creationPromise = new Promise<SessionSummary>((resolve, reject) => {
			this.pendingCreates.set(runnerKey, {
				runnerKey,
				resolve,
				reject,
				creationArgs: args,
			});
		});

		const newSessionPayload: Record<string, unknown> = {
			internalRunnerKey: runnerKey,
		};
		this.copyConfigFields(args, newSessionPayload);

		await this.core.handleClientMessage({
			type: "command",
			command: "new_session",
			payload: newSessionPayload,
		});

		await this.core.handleClientMessage({
			type: "command",
			command: "prompt",
			payload: { message: args.prompt!, internalRunnerKey: runnerKey },
		});

		return creationPromise;
	}

	private async activateDraftAndSend(
		draft: SessionRecord,
		message: string,
		opts?: { mode?: "steer" | "followUp" },
	): Promise<SendResult> {
		const runnerKey = `activate-${++this.creationCounter}`;
		const args = draft.creationArgs ?? {};

		const summaryPromise = new Promise<SessionSummary>((resolve, reject) => {
			this.pendingCreates.set(runnerKey, {
				runnerKey,
				resolve,
				reject,
				creationArgs: args,
				draftId: draft.id,
			});
		});

		const newSessionPayload: Record<string, unknown> = {
			internalRunnerKey: runnerKey,
		};
		this.copyConfigFields(args, newSessionPayload);

		await this.core.handleClientMessage({
			type: "command",
			command: "new_session",
			payload: newSessionPayload,
		});

		const promptPayload: Record<string, unknown> = {
			message,
			internalRunnerKey: runnerKey,
		};
		if (opts?.mode === "followUp") {
			promptPayload.queueMode = "followUp";
		}

		await this.core.handleClientMessage({
			type: "command",
			command: "prompt",
			payload: promptPayload,
		});

		const summary = await summaryPromise;

		draft.sessionPath = summary.sessionPath;
		draft.runnerKey = runnerKey;
		draft.status = "running";
		draft.title = summary.title || draft.title;
		draft.metadata = { ...draft.metadata, ...summary.metadata };
		draft.updatedAt = new Date().toISOString();

		return { queued: false };
	}

	private routeCoreOutput(
		message: unknown,
		metadata?: import("../../runnerCore").RunnerOutputMetadata,
	): void {
		const metaRunnerKey = metadata?.runnerKey;

		if (metaRunnerKey) {
			this.tryResolvePendingCreation(metaRunnerKey, message);
		}

		this.routePiEvent(message, metadata);
		this.routeSessionListUpdate(message);
	}

	private tryResolvePendingCreation(runnerKey: string, message: unknown): void {
		const pending = this.pendingCreates.get(runnerKey);
		if (!pending) {
			return;
		}

		// Reject on terminal conditions (errors, early exit) before creation completes
		if (this.isTerminalForPending(message)) {
			this.pendingCreates.delete(runnerKey);
			pending.reject(
				new Error(
					this.isRecord(message)
						? this.pendingErrorMessage(message)
						: "Session creation failed",
				),
			);
			return;
		}

		if (!this.isGetStateResponse(message)) {
			return;
		}

		const data = this.getResponseData(message);
		const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
		const sessionPath =
			typeof data?.sessionFile === "string" ? data.sessionFile : "";
		const sessionName =
			typeof data?.sessionName === "string" ? data.sessionName : "";

		if (!sessionId && !sessionPath) {
			return;
		}

		const summary = this.registerActiveSession({
			sessionId,
			sessionPath,
			sessionName,
			runnerKey,
			creationArgs: pending.creationArgs,
			draftId: pending.draftId,
		});

		this.pendingCreates.delete(runnerKey);
		pending.resolve(summary);
	}

	private isTerminalForPending(message: unknown): boolean {
		if (!this.isRecord(message)) {
			return false;
		}

		// Bridge-level error
		if (message.source === "bridge" && message.type === "error") {
			return true;
		}

		// Pi response with error
		if (message.source === "pi" && message.type === "response") {
			const response = message.response;
			if (this.isRecord(response) && response.error) {
				return true;
			}
		}

		// Pi process exited before creation completed
		if (
			message.source === "pi" &&
			message.type === "status" &&
			message.status === "exited"
		) {
			return true;
		}

		return false;
	}

	private pendingErrorMessage(message: Record<string, unknown>): string {
		if (message.source === "bridge" && message.type === "error") {
			return typeof message.message === "string"
				? message.message
				: "Bridge error";
		}
		if (
			message.source === "pi" &&
			message.type === "status" &&
			message.status === "exited"
		) {
			return "Pi process exited before session was created";
		}
		return "Session creation failed";
	}

	private registerActiveSession(info: {
		sessionId: string;
		sessionPath: string;
		sessionName: string;
		runnerKey: string;
		creationArgs?: CreateSessionArgs;
		draftId?: string;
	}): SessionSummary {
		const now = new Date().toISOString();
		const id = info.draftId || info.sessionId || info.sessionPath;

		const existing = this.sessions.get(id);
		const title =
			info.sessionName?.trim() ||
			info.creationArgs?.title?.trim() ||
			existing?.title ||
			"New session";

		const kind = info.creationArgs?.kind ?? existing?.kind;

		const record: SessionRecord = {
			id,
			title,
			status: "running",
			kind,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			sessionPath: info.sessionPath,
			runnerKey: info.runnerKey,
			metadata: this.collectMetadata(info.creationArgs ?? {}),
			messages: existing?.messages ?? [],
			streamCursor: existing?.streamCursor ?? "",
		};

		this.sessions.set(id, record);
		this.runnerKeyToId.set(info.runnerKey, id);
		this.pathToId.set(info.sessionPath, id);
		this.runnerKeyToId.set(`path:${info.sessionPath}`, id);

		const summary = this.toSummary(record);

		this.notifySessionListChanged();

		return summary;
	}

	private routePiEvent(
		message: unknown,
		metadata?: import("../../runnerCore").RunnerOutputMetadata,
	): void {
		if (!this.isRecord(message)) {
			return;
		}

		const sessionId = this.resolveSessionId(metadata);
		if (!sessionId) {
			return;
		}

		const session = this.sessions.get(sessionId);
		const streamEvent = this.toStreamEvent(message, sessionId);
		if (!streamEvent) {
			return;
		}

		session?.messages.push(message);
		if (session) {
			session.streamCursor = streamEvent.eventId;
			session.updatedAt = new Date().toISOString();
		}

		this.handlePiStatus(message, session);

		const subscribers = this.sessionSubscribers.get(sessionId);
		if (subscribers) {
			const eventId = streamEvent.eventId;
			for (const [onEvent, cursor] of subscribers) {
				if (!isAfterCursor(eventId, cursor)) {
					continue;
				}
				try {
					onEvent(streamEvent);
				} catch {
					// subscriber error is non-fatal
				}
			}
		}
	}

	private routeSessionListUpdate(message: unknown): void {
		if (!this.isBridgeSessionsMessage(message)) {
			return;
		}

		void this.buildSessionList().then((summaries) => {
			for (const subscriber of this.listSubscribers) {
				try {
					subscriber(summaries);
				} catch {
					// subscriber error is non-fatal
				}
			}
		});
	}

	private resolveSessionId(
		metadata?: import("../../runnerCore").RunnerOutputMetadata,
	): string | undefined {
		if (metadata?.sessionPath) {
			const id = this.pathToId.get(metadata.sessionPath);
			if (id) {
				return id;
			}
		}

		if (metadata?.runnerKey) {
			return this.runnerKeyToId.get(metadata.runnerKey);
		}

		return undefined;
	}

	private toStreamEvent(
		message: Record<string, unknown>,
		sessionId: string,
	): StreamEvent | null {
		const source = message.source;

		if (source === "pi") {
			if (message.type === "event" && this.isRecord(message.event)) {
				return this.streamEvent("pi.event", sessionId, {
					event: message.event,
				});
			}

			if (message.type === "response") {
				return this.streamEvent("pi.response", sessionId, {
					response: message.response,
				});
			}

			if (message.type === "status") {
				return this.streamEvent("pi.status", sessionId, {
					status: message.status,
				});
			}

			if (message.type === "stderr") {
				return this.streamEvent("pi.stderr", sessionId, { data: message.data });
			}
		}

		if (source === "bridge") {
			if (message.type === "error") {
				return this.streamEvent("error", sessionId, {
					message:
						typeof message.message === "string"
							? message.message
							: String(message.message ?? ""),
				});
			}
		}

		return null;
	}

	private handlePiStatus(
		message: Record<string, unknown>,
		session?: SessionRecord,
	): void {
		if (message.source !== "pi" || message.type !== "status") {
			return;
		}

		if (!session) {
			return;
		}

		const status = typeof message.status === "string" ? message.status : "";

		if (status === "starting" || status === "running") {
			session.status = "running";
		} else if (status === "exited") {
			session.status = "stopped";
			session.runnerKey = undefined;
		}
	}

	private async buildSessionList(): Promise<SessionSummary[]> {
		const persistedSessions = await this.listSessionsFn(
			this.cwd,
			this.sessionDir,
		);

		for (const piSession of persistedSessions) {
			const existingId = this.pathToId.get(piSession.path);
			if (existingId) {
				this.syncExistingRecord(existingId, piSession);
				continue;
			}

			const record = this.createSessionRecordFromPi(piSession);
			this.sessions.set(piSession.id, record);
			this.pathToId.set(piSession.path, piSession.id);
		}

		const summaries: SessionSummary[] = [];
		for (const record of this.sessions.values()) {
			summaries.push(this.toSummary(record));
		}

		return summaries.sort(
			(a, b) =>
				new Date(b.updatedAt ?? 0).getTime() -
				new Date(a.updatedAt ?? 0).getTime(),
		);
	}

	private syncExistingRecord(
		id: string,
		piSession: { id: string; path: string; title: string; modified: string },
	): void {
		const record = this.sessions.get(id);
		if (!record) {
			return;
		}

		record.updatedAt = piSession.modified;
		record.sessionPath = piSession.path;
	}

	private createSessionRecordFromPi(piSession: {
		id: string;
		path: string;
		title: string;
		created: string;
		modified: string;
	}): SessionRecord {
		const existingByPath = this.pathToId.get(piSession.path);
		const status = existingByPath
			? (this.sessions.get(existingByPath)?.status ?? "idle")
			: "idle";

		return {
			id: piSession.id,
			title: piSession.title,
			status,
			createdAt: piSession.created,
			updatedAt: piSession.modified,
			sessionPath: piSession.path,
			metadata: {},
			messages: [],
			streamCursor: "",
		};
	}

	private toSummary(record: SessionRecord): SessionSummary {
		return {
			id: record.id,
			title: record.title,
			status: record.status,
			kind: record.kind as SessionSummary["kind"],
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			sessionPath: record.sessionPath,
			metadata: { ...record.metadata },
		};
	}

	private streamEvent(
		type: StreamEvent["type"],
		sessionId: string,
		payload: Record<string, unknown>,
	): StreamEvent {
		return {
			type,
			sessionId,
			eventId: `evt-${++this.eventCounter}`,
			createdAt: new Date().toISOString(),
			payload,
		};
	}

	private notifySessionListChanged(): void {
		const summaries = this.buildSessionListFromMemory();
		for (const subscriber of this.listSubscribers) {
			try {
				subscriber(summaries);
			} catch {
				// subscriber error is non-fatal
			}
		}
	}

	private buildSessionListFromMemory(): SessionSummary[] {
		const summaries: SessionSummary[] = [];
		for (const record of this.sessions.values()) {
			summaries.push(this.toSummary(record));
		}
		return summaries.sort(
			(a, b) =>
				new Date(b.updatedAt ?? 0).getTime() -
				new Date(a.updatedAt ?? 0).getTime(),
		);
	}

	private collectMetadata(args: CreateSessionArgs): Record<string, unknown> {
		const metadata: Record<string, unknown> = { ...(args.metadata ?? {}) };
		if (args.projectId) {
			metadata.projectId = args.projectId;
		}
		if (args.workflowPath) {
			metadata.workflowPath = args.workflowPath;
		}
		if (args.cwd) {
			metadata.cwd = args.cwd;
		}
		return metadata;
	}

	private copyConfigFields(
		args: CreateSessionArgs,
		payload: Record<string, unknown>,
	): void {
		if (args.provider) {
			payload.provider = args.provider;
		}
		if (args.model) {
			payload.model = args.model;
		}
		if (args.profile) {
			payload.profile = args.profile;
		}
		if (args.cwd) {
			payload.cwd = args.cwd;
		}
	}

	private isGetStateResponse(
		message: unknown,
	): message is Record<string, unknown> {
		if (!this.isRecord(message)) {
			return false;
		}
		if (message.source !== "pi") {
			return false;
		}
		if (message.type !== "response") {
			return false;
		}
		if (!this.isRecord(message.response)) {
			return false;
		}
		return message.response.command === "get_state";
	}

	private getResponseData(
		message: Record<string, unknown>,
	): Record<string, unknown> | undefined {
		const response = message.response ?? message;
		if (!this.isRecord(response)) {
			return undefined;
		}
		const data = response.data;
		return this.isRecord(data) ? data : undefined;
	}

	private isBridgeSessionsMessage(
		message: unknown,
	): message is Record<string, unknown> {
		return (
			this.isRecord(message) &&
			message.source === "bridge" &&
			message.type === "sessions"
		);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
}

/**
 * Returns true when `eventId` is after `cursor`.  Cursors from
 * {@link SessionSnapshot.streamCursor} use the {@code evt-{N}} format;
 * unrecognised formats are treated as "no cursor" (accept everything).
 */
function isAfterCursor(eventId: string, cursor: string): boolean {
	if (!cursor) {
		return true;
	}

	const cursorNum = cursorValue(cursor);
	if (cursorNum < 0) {
		return true;
	}

	const eventNum = cursorValue(eventId);
	if (eventNum < 0) {
		return true;
	}

	return eventNum > cursorNum;
}

function cursorValue(cursor: string): number {
	const match = cursor.match(/^evt-(\d+)$/);
	if (!match) {
		return -1;
	}
	return parseInt(match[1], 10);
}
