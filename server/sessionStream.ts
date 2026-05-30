import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	SessionManager,
	SessionSummary,
	StreamEvent,
	Unsubscribe,
} from "../src/lib/sessionApi";

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_REPLAY_CAPACITY = 500;

type SessionStreamHandlerOptions = {
	manager: SessionManager;
	heartbeatMs?: number;
	replayCapacity?: number;
};

type StreamRequest = {
	sessionId?: string;
	includeList: boolean;
	lastEventId?: string;
};

export function createSessionStreamHandler(
	options: SessionStreamHandlerOptions,
) {
	const replayCapacity = Math.max(
		1,
		options.replayCapacity ?? DEFAULT_REPLAY_CAPACITY,
	);
	const replayBuffer: StreamEvent[] = [];
	let generatedEventCounter = 0;

	return (req: IncomingMessage, res: ServerResponse): boolean => {
		const url = new URL(
			req.url ?? "/",
			`http://${req.headers.host ?? "localhost"}`,
		);
		if (url.pathname !== "/api/stream") {
			return false;
		}

		if (req.method !== "GET") {
			writeJson(res, 405, { ok: false, error: "method_not_allowed" });
			return true;
		}

		const request = parseStreamRequest(url, req.headers["last-event-id"]);
		if (!request) {
			writeJson(res, 400, { ok: false, error: "stream_subscription_required" });
			return true;
		}

		startStream(req, res, request);
		return true;
	};

	function startStream(
		req: IncomingMessage,
		res: ServerResponse,
		request: StreamRequest,
	): void {
		const unsubscribes: Unsubscribe[] = [];
		let closed = false;

		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		res.flushHeaders?.();

		const heartbeat = setInterval(() => {
			writeRaw(res, ": heartbeat\n\n");
		}, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

		const cleanup = () => {
			if (closed) {
				return;
			}
			closed = true;
			clearInterval(heartbeat);
			for (const unsubscribe of unsubscribes.splice(0)) {
				unsubscribe();
			}
		};

		req.on("close", cleanup);
		res.on("close", cleanup);

		for (const event of replayAfter(request.lastEventId, request)) {
			writeEvent(res, event);
		}

		if (request.sessionId) {
			unsubscribes.push(
				options.manager.subscribeToSession(
					request.sessionId,
					(event) => {
						const streamEvent = remember(event);
						writeEvent(res, streamEvent);
					},
					{ cursor: request.lastEventId },
				),
			);
		}

		if (request.includeList) {
			unsubscribes.push(
				options.manager.subscribeToSessionList((sessions) => {
					const streamEvent = remember(createListUpdateEvent(sessions));
					writeEvent(res, streamEvent);
				}),
			);
		}
	}

	function createListUpdateEvent(sessions: SessionSummary[]): StreamEvent {
		return {
			type: "session.list.updated",
			eventId: nextGeneratedEventId(),
			createdAt: new Date().toISOString(),
			payload: { sessions },
		};
	}

	function remember(event: StreamEvent): StreamEvent {
		const normalized = normalizeEvent(event);
		if (
			replayBuffer.some((buffered) => buffered.eventId === normalized.eventId)
		) {
			return normalized;
		}

		replayBuffer.push(normalized);
		while (replayBuffer.length > replayCapacity) {
			replayBuffer.shift();
		}
		return normalized;
	}

	function normalizeEvent(event: StreamEvent): StreamEvent {
		if (event.eventId) {
			return event;
		}

		return {
			...event,
			eventId: nextGeneratedEventId(),
		};
	}

	function nextGeneratedEventId(): string {
		return `sse-${++generatedEventCounter}`;
	}

	function replayAfter(
		lastEventId: string | undefined,
		request: StreamRequest,
	): StreamEvent[] {
		if (!lastEventId) {
			return [];
		}

		// Exact match covers native SSE reconnects (Last-Event-ID) and the
		// common case where the cursor event is still buffered.
		const cursorIndex = replayBuffer.findIndex(
			(event) => event.eventId === lastEventId,
		);
		if (cursorIndex !== -1) {
			return replayBuffer
				.slice(cursorIndex + 1)
				.filter((event) => eventMatchesRequest(event, request));
		}

		// Fallback: if the exact cursor has been evicted from the buffer but
		// newer events remain (possible when a snapshot cursor points to an
		// older event the buffer no longer holds), replay every buffered event
		// whose numeric id is after the cursor.  Only recognised formats
		// (evt-{N}, sse-{N}) use numeric comparison; unrecognised cursors
		// produce no replay so the subscription only receives future events.
		const cursorValue = parseNumericEventId(lastEventId);
		if (cursorValue >= 0) {
			return replayBuffer
				.filter(
					(event) =>
						parseNumericEventId(event.eventId) > cursorValue &&
						eventMatchesRequest(event, request),
				)
				.slice();
		}

		return [];
	}
}

/**
 * Extract the trailing numeric id from event-id formats {@code evt-{N}}
 * and {@code sse-{N}}, returning -1 for unrecognised formats.
 */
export function parseNumericEventId(eventId: string | undefined): number {
	if (!eventId) {
		return -1;
	}
	const match = eventId.match(/^(?:evt|sse)-(\d+)$/);
	if (!match) {
		return -1;
	}
	return parseInt(match[1], 10);
}

function parseStreamRequest(
	url: URL,
	lastEventHeader: string | string[] | undefined,
): StreamRequest | null {
	const sessionId = nonEmpty(url.searchParams.get("session"));
	const includeList = url.searchParams.get("list") === "true";

	if (!sessionId && !includeList) {
		return null;
	}

	// Browsers cannot set Last-Event-ID on the initial EventSource request,
	// so the RPC client encodes the cursor as a query parameter instead.
	// Prefer the standard header when present (native reconnect).
	const cursorParam = nonEmpty(url.searchParams.get("cursor"));
	let lastEventId: string | undefined;
	if (Array.isArray(lastEventHeader)) {
		lastEventId = lastEventHeader[0];
	} else if (lastEventHeader) {
		lastEventId = lastEventHeader;
	} else {
		lastEventId = cursorParam;
	}

	return {
		sessionId,
		includeList,
		lastEventId,
	};
}

function nonEmpty(value: string | null): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function eventMatchesRequest(
	event: StreamEvent,
	request: StreamRequest,
): boolean {
	if (request.sessionId && event.sessionId === request.sessionId) {
		return true;
	}

	return request.includeList && event.type === "session.list.updated";
}

function writeEvent(res: ServerResponse, event: StreamEvent): void {
	writeRaw(
		res,
		`event: ${event.type}\nid: ${event.eventId}\ndata: ${JSON.stringify({
			sessionId: event.sessionId ?? null,
			eventId: event.eventId,
			createdAt: event.createdAt,
			payload: event.payload,
		})}\n\n`,
	);
}

function writeRaw(res: ServerResponse, chunk: string): void {
	if (!res.destroyed && !res.writableEnded) {
		res.write(chunk);
	}
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}
