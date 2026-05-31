import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getSessionManager,
	installSessionManagerInjectionApi,
	resetSessionManager,
	setSessionManager,
} from "../src/lib/sessionManagerInstance";
import type { SessionManager, SessionSummary } from "../src/lib/sessionApi";
import { createEmptySessionView } from "../src/protocol/types";

type TestWindow = {
	__agentWeb__?: {
		sessionManager?: SessionManager;
		[key: string]: unknown;
	};
};

let originalWindowDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
	originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
	resetSessionManager();
	delete (globalThis as { window?: unknown }).window;
});

afterEach(() => {
	resetSessionManager();
	if (originalWindowDescriptor) {
		Object.defineProperty(globalThis, "window", originalWindowDescriptor);
	} else {
		delete (globalThis as { window?: unknown }).window;
	}
});

describe("session manager injection", () => {
	it("uses window.__agentWeb__.sessionManager as the supported startup injection", () => {
		const manager = mockSessionManager("startup");
		setTestWindow({ __agentWeb__: { sessionManager: manager } });

		expect(getSessionManager()).toBe(manager);
	});

	it("setSessionManager installs and replaces the cached manager", () => {
		setTestWindow({});
		const first = mockSessionManager("first");
		const second = mockSessionManager("second");

		setSessionManager(first);
		expect(getSessionManager()).toBe(first);
		expect((window as TestWindow).__agentWeb__?.sessionManager).toBe(first);

		setSessionManager(second);
		expect(getSessionManager()).toBe(second);
		expect((window as TestWindow).__agentWeb__?.sessionManager).toBe(second);
	});

	it("resetSessionManager clears the supported window injection and cached manager", () => {
		setTestWindow({});
		const first = mockSessionManager("first");
		const second = mockSessionManager("second");

		setSessionManager(first);
		resetSessionManager();

		expect((window as TestWindow).__agentWeb__?.sessionManager).toBeUndefined();
		(window as TestWindow).__agentWeb__ = { sessionManager: second };
		expect(getSessionManager()).toBe(second);
	});

	it("installs dev helpers without replacing preconfigured browser injection", () => {
		const manager = mockSessionManager("preconfigured");
		setTestWindow({
			__agentWeb__: { sessionManager: manager, existingFlag: true },
		});

		const api = installSessionManagerInjectionApi();

		expect(api?.sessionManager).toBe(manager);
		expect(api?.existingFlag).toBe(true);
		expect(api?.setSessionManager).toBe(setSessionManager);
		expect(api?.resetSessionManager).toBe(resetSessionManager);
	});
});

function setTestWindow(testWindow: TestWindow): void {
	Object.defineProperty(globalThis, "window", {
		value: testWindow,
		configurable: true,
		writable: true,
	});
}

function mockSessionManager(id: string): SessionManager {
	const session: SessionSummary = { id, title: id, status: "idle" };
	return {
		capabilities: {
			createSession: true,
			deleteSession: true,
			stopSession: true,
			setSessionMetadata: false,
			sendMessage: true,
			respondToUserRequest: true,
			backgroundSessions: false,
		},
		listSessions: vi.fn(async () => []),
		createSession: vi.fn(async () => session),
		deleteSession: vi.fn(async () => {}),
		openSession: vi.fn(async () => ({
			session,
			view: createEmptySessionView(session),
			streamCursor: "",
		})),
		sendMessage: vi.fn(async () => ({ queued: false })),
		stopSession: vi.fn(async () => {}),
		respondToUserRequest: vi.fn(async () => {}),
		subscribeToSession: vi.fn(() => () => {}),
		subscribeToSessionList: vi.fn(() => () => {}),
		openAndSubscribeSession: vi.fn(async () => ({
			snapshot: {
				session,
				view: createEmptySessionView(session),
				streamCursor: "",
			},
			unsubscribe: () => {},
		})),
	};
}
