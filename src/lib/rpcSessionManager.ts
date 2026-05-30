import type {
	CreateSessionArgs,
	SendResult,
	SessionManager,
	SessionManagerCapabilities,
	SessionSnapshot,
	SessionSummary,
	StreamEvent,
	StreamEventType,
	Unsubscribe,
	UserRequestResponse,
} from "./sessionApi";
import type { BrowserTransport } from "./browserTransport";
import { createBrowserTransport } from "./browserTransport";

export type RpcSessionManagerOptions = {
	/**
	 * Pre-built transport.  When provided, the individual `fetch`,
	 * `EventSource`, and `eventSource` options are ignored.
	 * `baseUrl` is still applied by the session manager for URL
	 * construction, regardless of whether a transport is supplied.
	 */
	transport?: BrowserTransport;

	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
	EventSource?: typeof globalThis.EventSource;
	eventSource?: typeof globalThis.EventSource;
};

export class RpcSessionManagerError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: unknown,
	) {
		super(message);
		this.name = "RpcSessionManagerError";
	}
}

const CAPABILITIES: SessionManagerCapabilities = {
	createSession: true,
	deleteSession: true,
	stopSession: true,
	setSessionMetadata: false,
	sendMessage: true,
	respondToUserRequest: true,
	backgroundSessions: false,
};

const STREAM_EVENT_TYPES: StreamEventType[] = [
	"session.created",
	"session.updated",
	"session.list.updated",
	"pi.event",
	"pi.response",
	"pi.status",
	"pi.stderr",
	"user_request.created",
	"error",
];

export function createRpcSessionManager(
	options: RpcSessionManagerOptions = {},
): SessionManager {
	return new RpcSessionManager(options);
}

export class RpcSessionManager implements SessionManager {
	readonly capabilities = CAPABILITIES;

	private readonly baseUrl: string;
	private readonly transport: BrowserTransport;

	constructor(options: RpcSessionManagerOptions = {}) {
		this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "";

		this.transport =
			options.transport ??
			createBrowserTransport({
				fetch: options.fetch,
				EventSource: options.EventSource ?? options.eventSource,
			});
	}

	async listSessions(query?: {
		status?: string;
		kind?: string;
	}): Promise<SessionSummary[]> {
		const result = await this.request<{ sessions: SessionSummary[] }>(
			"/api/sessions",
			{ method: "GET" },
			query,
		);
		return result.sessions;
	}

	createSession(args: CreateSessionArgs): Promise<SessionSummary> {
		return this.request("/api/sessions", {
			method: "POST",
			body: JSON.stringify(args),
			headers: { "content-type": "application/json" },
		});
	}

	deleteSession(id: string, opts?: { force?: boolean }): Promise<void> {
		return this.request(
			`/api/sessions/${encodeURIComponent(id)}`,
			{ method: "DELETE" },
			opts?.force === true ? { force: "true" } : undefined,
		);
	}

	openSession(id: string): Promise<SessionSnapshot> {
		return this.request(`/api/sessions/${encodeURIComponent(id)}`, {
			method: "GET",
		});
	}

	sendMessage(
		sessionId: string,
		message: string,
		opts?: { mode?: "steer" | "followUp" },
	): Promise<SendResult> {
		return this.request(
			`/api/sessions/${encodeURIComponent(sessionId)}/messages`,
			{
				method: "POST",
				body: JSON.stringify({
					message,
					...(opts?.mode ? { mode: opts.mode } : {}),
				}),
				headers: { "content-type": "application/json" },
			},
		);
	}

	stopSession(sessionId: string): Promise<void> {
		return this.request(
			`/api/sessions/${encodeURIComponent(sessionId)}/messages`,
			{
				method: "DELETE",
			},
		);
	}

	respondToUserRequest(
		sessionId: string,
		response: UserRequestResponse,
	): Promise<void> {
		return this.request(
			`/api/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(response.id)}`,
			{
				method: "POST",
				body: JSON.stringify(response),
				headers: { "content-type": "application/json" },
			},
		);
	}

	subscribeToSession(
		sessionId: string,
		onEvent: (event: StreamEvent) => void,
		opts?: { cursor?: string },
	): Unsubscribe {
		const source = this.transport.createEventSource(
			this.buildUrl("/api/stream", { session: sessionId, cursor: opts?.cursor }),
		);
		for (const type of STREAM_EVENT_TYPES) {
			source.addEventListener(type, (message) => {
				const event = parseStreamEvent(type, message);
				if (event) {
					onEvent(event);
				}
			});
		}

		return () => source.close();
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
		const source = this.transport.createEventSource(
			this.buildUrl("/api/stream", { list: "true" }),
		);
		// The list subscription only needs list update events; session-scoped
		// stream events are handled by subscribeToSession.
		source.addEventListener("session.list.updated", (message) => {
			const event = parseStreamEvent("session.list.updated", message);
			const sessions = event?.payload.sessions;
			if (Array.isArray(sessions)) {
				onUpdate(sessions as SessionSummary[]);
			}
		});

		return () => source.close();
	}

	private async request<T>(
		path: string,
		init: RequestInit,
		query?: Record<string, string | undefined>,
	): Promise<T> {
		const response = await this.transport.fetch(this.buildUrl(path, query), init);
		const body = await readBody(response);

		if (!response.ok) {
			throw createHttpError(response.status, body);
		}

		return body as T;
	}

	private buildUrl(
		path: string,
		query?: Record<string, string | undefined>,
	): string {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) {
				params.set(key, value);
			}
		}

		const queryString = params.toString();
		return `${this.baseUrl}${path}${queryString ? `?${queryString}` : ""}`;
	}
}

async function readBody(response: Response): Promise<unknown> {
	if (response.status === 204) {
		return undefined;
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		return response.json();
	}

	const text = await response.text();
	return text === "" ? undefined : text;
}

function createHttpError(
	status: number,
	body: unknown,
): RpcSessionManagerError {
	if (isRecord(body)) {
		const message =
			(typeof body.message === "string" && body.message) ||
			(typeof body.error === "string" && body.error) ||
			`HTTP ${status}`;
		return new RpcSessionManagerError(message, status, body);
	}

	if (typeof body === "string" && body) {
		return new RpcSessionManagerError(`HTTP ${status}: ${body}`, status, body);
	}

	return new RpcSessionManagerError(`HTTP ${status}`, status, body);
}

function parseStreamEvent(
	type: StreamEventType,
	message: MessageEvent,
): StreamEvent | null {
	if (typeof message.data !== "string") {
		return null;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(message.data);
	} catch {
		return null;
	}

	if (!isRecord(raw)) {
		return null;
	}

	const payload = isRecord(raw.payload) ? raw.payload : {};

	return {
		type,
		sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
		eventId:
			typeof raw.eventId === "string" ? raw.eventId : message.lastEventId,
		createdAt:
			typeof raw.createdAt === "string"
				? raw.createdAt
				: new Date().toISOString(),
		payload,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
