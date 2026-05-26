import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	SessionManager,
	UserRequestResponse,
} from "../src/lib/sessionApi";

export type SessionApiHandlerOptions = {
	manager: SessionManager;
};

export function createSessionApiHandler(
	options: SessionApiHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
	const { manager } = options;

	return async (req, res): Promise<boolean> => {
		const url = new URL(
			req.url ?? "/",
			`http://${req.headers.host ?? "localhost"}`,
		);
		const pathname = url.pathname;

		if (
			pathname !== "/api/sessions" &&
			!pathname.startsWith("/api/sessions/")
		) {
			return false;
		}

		const segments = pathname
			.replace(/^\/api\/sessions\/?/, "")
			.split("/")
			.filter(Boolean);

		try {
			// Route: /api/sessions
			if (segments.length === 0) {
				await handleSessionsCollection(req, res, url, manager);
				return true;
			}

			const sessionId = segments[0];

			// Route: /api/sessions/{sessionId}/requests/{requestId}
			if (segments.length === 3 && segments[1] === "requests") {
				await handleRequestResponse(req, res, manager, sessionId, segments[2]);
				return true;
			}

			// Route: /api/sessions/{sessionId}/messages
			if (segments.length === 2 && segments[1] === "messages") {
				await handleMessages(req, res, manager, sessionId);
				return true;
			}

			// Route: /api/sessions/{sessionId}
			if (segments.length === 1) {
				await handleSession(req, res, url, manager, sessionId);
				return true;
			}

			writeJson(res, 404, { error: "not_found" });
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isNotFound(message)) {
				writeJson(res, 404, { error: "not_found" });
			} else {
				writeJson(res, 500, { error: message });
			}
			return true;
		}
	};
}

// ── /api/sessions ──

async function handleSessionsCollection(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	manager: SessionManager,
): Promise<void> {
	if (req.method === "GET") {
		const status = url.searchParams.get("status") ?? undefined;
		const kind = url.searchParams.get("kind") ?? undefined;
		const sessions = await manager.listSessions(
			status || kind ? { status, kind } : undefined,
		);
		writeJson(res, 200, { sessions });
		return;
	}

	if (req.method === "POST") {
		const body = await parseJsonBody(req, res);
		if (body === null) {
			return;
		}
		const session = await manager.createSession(body);
		writeJson(res, 201, session);
		return;
	}

	writeMethodNotAllowed(res, ["GET", "POST"]);
}

// ── /api/sessions/{sessionId} ──

async function handleSession(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	manager: SessionManager,
	sessionId: string,
): Promise<void> {
	if (req.method === "GET") {
		const snapshot = await manager.openSession(sessionId);
		writeJson(res, 200, snapshot);
		return;
	}

	if (req.method === "PATCH") {
		if (!manager.capabilities.setSessionMetadata) {
			writeJson(res, 501, {
				error: "unsupported_capability",
				capability: "setSessionMetadata",
			});
			return;
		}

		// When a backend supports setSessionMetadata, parse the body
		// and delegate to the manager.  Not yet wired because the
		// SessionManager interface has no update method.
		writeJson(res, 501, {
			error: "not_implemented",
			message: "Session metadata update is not yet wired to the backend.",
		});
		return;
	}

	if (req.method === "DELETE") {
		if (!manager.capabilities.deleteSession) {
			writeJson(res, 501, {
				error: "unsupported_capability",
				capability: "deleteSession",
			});
			return;
		}

		const force = url.searchParams.get("force") === "true";
		try {
			await manager.deleteSession(sessionId, { force });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/running/i.test(message)) {
				writeJson(res, 409, { error: "conflict", message });
				return;
			}
			throw error;
		}
		res.writeHead(204);
		res.end();
		return;
	}

	writeMethodNotAllowed(res, ["GET", "PATCH", "DELETE"]);
}

// ── /api/sessions/{sessionId}/messages ──

async function handleMessages(
	req: IncomingMessage,
	res: ServerResponse,
	manager: SessionManager,
	sessionId: string,
): Promise<void> {
	if (req.method === "POST") {
		const body = await parseJsonBody(req, res);
		if (body === null) {
			return;
		}

		const message = body.message;
		if (typeof message !== "string" || message.trim() === "") {
			writeJson(res, 400, { error: "message_required" });
			return;
		}

		if (
			body.mode !== undefined &&
			body.mode !== "steer" &&
			body.mode !== "followUp"
		) {
			writeJson(res, 400, {
				error: "invalid_field",
				field: "mode",
				message: 'Must be "steer" or "followUp".',
			});
			return;
		}

		const mode = body.mode as "steer" | "followUp" | undefined;

		const result = await manager.sendMessage(sessionId, message, {
			mode,
		});
		writeJson(res, 200, result);
		return;
	}

	if (req.method === "DELETE") {
		if (!manager.capabilities.stopSession) {
			writeJson(res, 501, {
				error: "unsupported_capability",
				capability: "stopSession",
			});
			return;
		}

		await manager.stopSession(sessionId);
		res.writeHead(204);
		res.end();
		return;
	}

	writeMethodNotAllowed(res, ["POST", "DELETE"]);
}

// ── /api/sessions/{sessionId}/requests/{requestId} ──

async function handleRequestResponse(
	req: IncomingMessage,
	res: ServerResponse,
	manager: SessionManager,
	sessionId: string,
	requestId: string,
): Promise<void> {
	if (req.method !== "POST") {
		writeMethodNotAllowed(res, ["POST"]);
		return;
	}

	const body = await parseJsonBody(req, res);
	if (body === null) {
		return;
	}

	const bodyId = body.id;
	if (typeof bodyId !== "string") {
		writeJson(res, 400, { error: "id_required" });
		return;
	}

	if (bodyId !== requestId) {
		writeJson(res, 400, {
			error: "request_id_mismatch",
			message: `Body id "${bodyId}" does not match path requestId "${requestId}".`,
		});
		return;
	}

	if (body.cancelled !== undefined && typeof body.cancelled !== "boolean") {
		writeJson(res, 400, {
			error: "invalid_field",
			field: "cancelled",
			message: "Must be a boolean.",
		});
		return;
	}

	if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") {
		writeJson(res, 400, {
			error: "invalid_field",
			field: "confirmed",
			message: "Must be a boolean.",
		});
		return;
	}

	const response: UserRequestResponse = {
		id: bodyId,
		cancelled: body.cancelled as boolean | undefined,
		confirmed: body.confirmed as boolean | undefined,
		value: body.value !== undefined ? body.value : undefined,
	};

	await manager.respondToUserRequest(sessionId, response);
	res.writeHead(204);
	res.end();
}

// ── Helpers ──

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk: Buffer) => {
			data += chunk.toString();
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

async function parseJsonBody(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<Record<string, unknown> | null> {
	const raw = await readBody(req).catch(() => "");
	if (raw.trim() === "") {
		writeJson(res, 400, { error: "body_required" });
		return null;
	}

	try {
		const parsed = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			writeJson(res, 400, { error: "invalid_json" });
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		writeJson(res, 400, { error: "invalid_json" });
		return null;
	}
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

function writeMethodNotAllowed(res: ServerResponse, allowed: string[]): void {
	res.writeHead(405, {
		"content-type": "application/json",
		allow: allowed.join(", "),
	});
	res.end(JSON.stringify({ error: "method_not_allowed" }));
}

function isNotFound(message: string): boolean {
	return /not\s+found/i.test(message);
}
