import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import {
	AgentWebApp,
	createRpcSessionManager,
	resetSessionManager,
	setSessionManager,
} from "../src/index";
import type {
	CreateSessionArgs,
	PiDirectBackendOptions,
	SessionManager,
	SessionSnapshot,
	SessionSummary,
	StreamEvent,
	Unsubscribe,
} from "../src/index";

describe("package entrypoint", () => {
	it("declares the reusable package name and root export", () => {
		expect(packageJson.name).toBe("@shishberg/agent-web");
		expect(packageJson.exports?.["."]).toMatchObject({
			import: "./dist/package/agent-web.js",
			types: "./dist/types/src/index.d.ts",
		});
	});

	it("declares the session-protocol export subpath", () => {
		expect(packageJson.exports?.["./session-protocol"]).toMatchObject({
			import: "./dist/package/session-protocol.js",
			types: "./dist/types/src/sessionProtocolEntry.d.ts",
		});
	});

	it("exports the Vue app and session manager API", () => {
		expect(AgentWebApp).toBeTruthy();
		expect(createRpcSessionManager).toBeTypeOf("function");
		expect(setSessionManager).toBeTypeOf("function");
		expect(resetSessionManager).toBeTypeOf("function");

		const options: PiDirectBackendOptions = { cwd: "/tmp/agent-web" };
		expect(options.cwd).toBe("/tmp/agent-web");

		const session: SessionSummary = { id: "s1", title: "One", status: "idle" };
		const snapshot: SessionSnapshot = {
			session,
			view: {
				session,
				items: [],
				status: "idle",
				statusText: "",
				pendingRequests: [],
				extensionDraft: null,
				cursor: "",
			},
			streamCursor: "evt-1",
		};
		const event: StreamEvent = {
			type: "session.updated",
			sessionId: session.id,
			eventId: "evt-2",
			createdAt: "2026-05-26T00:00:00.000Z",
			payload: { session },
		};
		const createArgs: CreateSessionArgs = { title: "Draft" };
		const unsubscribe: Unsubscribe = () => {};
		const manager = {
			capabilities: {
				createSession: true,
				deleteSession: true,
				stopSession: true,
				setSessionMetadata: false,
				sendMessage: true,
				respondToUserRequest: true,
				backgroundSessions: false,
			},
		} as SessionManager;

		expect(snapshot.session).toBe(session);
		expect(event.payload.session).toBe(session);
		expect(createArgs.title).toBe("Draft");
		expect(typeof unsubscribe).toBe("function");
		expect(manager.capabilities.createSession).toBe(true);
	});
});
