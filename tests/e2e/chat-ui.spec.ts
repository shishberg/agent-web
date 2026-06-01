import { expect, test } from "@playwright/test";

// ── Mock SessionManager helpers ──

async function setupMockManager(page: import("@playwright/test").Page) {
	await page.addInitScript(() => {
		const ctrl: Record<string, any> = {
			sessions: [],
			snapshots: {},
			sentMessages: [],
			createdSessions: [],
			extensionResponses: [],
			sessionSubscriptions: {},
			listCallback: null,
			openSessionErrors: {},
			createSessionErrors: null,
			sendMessageErrors: {},
		};

		(window as any).__mockControl__ = ctrl;

		const sessionManager = {
			capabilities: {
				createSession: true,
				deleteSession: false,
				stopSession: true,
				setSessionMetadata: false,
				sendMessage: true,
				respondToUserRequest: true,
				backgroundSessions: false,
			},

			listSessions: async () => {
				return [...ctrl.sessions];
			},

			createSession: async (args: any) => {
				if (ctrl.createSessionErrors) {
					throw ctrl.createSessionErrors;
				}
				const session = {
					id: args.prompt
						? "mock-promised-" + Date.now()
						: "mock-draft-" + Date.now(),
					title: args.title || "New session",
					status: "idle",
					sessionPath: args.prompt ? "/tmp/pi/mock-session.jsonl" : undefined,
				};
				ctrl.createdSessions.push(session);
				return session;
			},

			deleteSession: async (_id: string) => {},

			openSession: async (id: string) => {
				const error = ctrl.openSessionErrors[id];
				if (error) {
					throw new Error(error);
				}
				const snapshot = ctrl.snapshots[id];
				if (snapshot) {
					return snapshot;
				}
				return {
					session: { id, title: "Session " + id, status: "idle" },
					view: {
						session: { id, title: "Session " + id, status: "idle" },
						items: [],
						status: "idle",
						statusText: "",
						pendingRequests: [],
						extensionDraft: null,
						cursor: "",
					},
					streamCursor: "",
				};
			},

			sendMessage: async (
				sessionId: string,
				message: string,
				opts?: { mode?: string },
			) => {
				const error = ctrl.sendMessageErrors[sessionId];
				if (error) {
					throw new Error(error);
				}
				ctrl.sentMessages.push({
					sessionId,
					message,
					mode: opts?.mode,
				});
				return { queued: false };
			},

			stopSession: async (_sessionId: string) => {},

			respondToUserRequest: async (sessionId: string, response: any) => {
				ctrl.extensionResponses.push({ sessionId, response });
			},

			subscribeToSession: (
				sessionId: string,
				onEvent: any,
				_opts?: { cursor?: string },
			) => {
				ctrl.sessionSubscriptions[sessionId] = onEvent;
				return () => {
					delete ctrl.sessionSubscriptions[sessionId];
				};
			},

			subscribeToSessionList: (onUpdate: any) => {
				ctrl.listCallback = onUpdate;
				return () => {
					ctrl.listCallback = null;
				};
			},

			openAndSubscribeSession: async (id: string, onEvent: any) => {
				const snapshot = await sessionManager.openSession(id);
				const unsubscribe = sessionManager.subscribeToSession(id, onEvent, {
					cursor: snapshot.streamCursor,
				});
				return { snapshot, unsubscribe };
			},
		};

		(window as any).__agentWeb__ = {
			...(window as any).__agentWeb__,
			sessionManager,
		};
	});
}

async function pushEvent(
	page: import("@playwright/test").Page,
	sessionId: string,
	event: any,
) {
	await page.evaluate(
		({ sid, evt }: { sid: string; evt: any }) => {
			const fn = (window as any).__mockControl__?.sessionSubscriptions?.[sid];
			if (fn) {
				fn(evt);
			}
		},
		{ sid: sessionId, evt: event },
	);
}

function streamEvent(
	type: string,
	sessionId: string,
	payload: Record<string, unknown>,
) {
	return {
		type,
		sessionId,
		eventId: "mock-ev-" + Math.random().toString(36).slice(2),
		createdAt: new Date().toISOString(),
		payload,
	};
}

async function getSentMessages(page: import("@playwright/test").Page) {
	return page.evaluate(
		() => (window as any).__mockControl__?.sentMessages || [],
	);
}

async function getExtensionResponses(page: import("@playwright/test").Page) {
	return page.evaluate(
		() => (window as any).__mockControl__?.extensionResponses || [],
	);
}

async function getCreatedSessions(page: import("@playwright/test").Page) {
	return page.evaluate(
		() => (window as any).__mockControl__?.createdSessions || [],
	);
}

// ── Tests ──

test("loads the empty chat prompt", async ({ page }) => {
	await setupMockManager(page);
	await page.goto("/");

	await expect(
		page.getByRole("heading", { name: "Start a chat with Pi" }),
	).toBeVisible();
	await expect(
		page.getByText("Send a prompt or open a saved session."),
	).toBeVisible();
	await expect(page.locator("[data-extension-slot]")).toHaveCount(0);
});

test("renders registered extension panels in App layout slots", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.addInitScript(() => {
		const panels = [
			{
				id: "test.sidebarTop",
				title: "Sidebar top panel",
				slot: "sidebar.top",
				body: "Sidebar top mounted",
			},
			{
				id: "test.sidebarTop.second",
				title: "Second top panel",
				slot: "sidebar.top",
				body: "Second sidebar top mounted",
			},
			{
				id: "test.afterSessions",
				title: "After sessions panel",
				slot: "sidebar.afterSessions",
				body: "After sessions mounted",
			},
			{
				id: "test.sidebarBottom",
				title: "Sidebar bottom panel",
				slot: "sidebar.bottom",
				body: "Sidebar bottom mounted",
			},
			{
				id: "test.composerBefore",
				title: "Composer before panel",
				slot: "composer.before",
				body: "Composer before mounted",
			},
			{
				id: "test.sessionDetails",
				title: "Session details panel",
				slot: "session.details",
				body: "Session details mounted",
			},
		];

		(window as any).__agentWebExtensions__ = {
			panels: panels.map((panel) => ({
				id: panel.id,
				title: panel.title,
				slot: panel.slot,
				mount(root: HTMLElement) {
					root.textContent = panel.body;
					root.dataset.mountedSlot = panel.slot;
					return () => {
						root.textContent = "";
					};
				},
			})),
		};
	});
	await page.goto("/");

	await expect(
		page.locator(
			'[data-extension-slot="sidebar.top"] [data-panel="test.sidebarTop"]',
		),
	).toContainText("Sidebar top mounted");
	await expect(
		page.locator('[data-extension-slot="sidebar.top"] [data-panel]'),
	).toHaveCount(2);
	await expect(
		page.locator(
			'[data-extension-slot="sidebar.afterSessions"] [data-panel="test.afterSessions"]',
		),
	).toContainText("After sessions mounted");
	await expect(
		page.locator(
			'[data-extension-slot="sidebar.bottom"] [data-panel="test.sidebarBottom"]',
		),
	).toContainText("Sidebar bottom mounted");
	await expect(
		page.locator(
			'[data-extension-slot="composer.before"] [data-panel="test.composerBefore"]',
		),
	).toContainText("Composer before mounted");

	await expect
		.poll(() =>
			page.evaluate(() => {
				const sidebarTop = document.querySelector(
					'[data-extension-slot="sidebar.top"]',
				);
				const sessionList = document.querySelector(".session-list");
				const afterSessions = document.querySelector(
					'[data-extension-slot="sidebar.afterSessions"]',
				);
				const sidebarBottom = document.querySelector(
					'[data-extension-slot="sidebar.bottom"]',
				);
				const profile = document.querySelector(".profile-row");
				const composerBefore = document.querySelector(
					'[data-extension-slot="composer.before"]',
				);
				const promptInput = document.querySelector(".prompt-input");

				return Boolean(
					sidebarTop &&
						sessionList &&
						afterSessions &&
						sidebarBottom &&
						profile &&
						composerBefore &&
						promptInput &&
						sidebarTop.compareDocumentPosition(sessionList) &
							Node.DOCUMENT_POSITION_FOLLOWING &&
						sessionList.compareDocumentPosition(afterSessions) &
							Node.DOCUMENT_POSITION_FOLLOWING &&
						afterSessions.compareDocumentPosition(sidebarBottom) &
							Node.DOCUMENT_POSITION_FOLLOWING &&
						sidebarBottom.compareDocumentPosition(profile) &
							Node.DOCUMENT_POSITION_FOLLOWING &&
						composerBefore.compareDocumentPosition(promptInput) &
							Node.DOCUMENT_POSITION_FOLLOWING,
				);
			}),
		)
		.toBe(true);

	await page.getByRole("button", { name: "Session details" }).click();
	const detailsDialog = page.getByRole("dialog", { name: "Session details" });
	await expect(
		detailsDialog.locator(
			'[data-extension-slot="session.details"] [data-panel="test.sessionDetails"]',
		),
	).toContainText("Session details mounted");
});

test("cycles the theme on the document root", async ({ page }) => {
	await setupMockManager(page);
	await page.addInitScript(() => {
		localStorage.setItem("agent-web-theme", "light");
	});
	await page.goto("/");

	const root = page.locator("html");
	const initialTheme = await root.getAttribute("data-theme");
	await page.getByRole("button", { name: /^Theme:/ }).click();

	await expect
		.poll(() => root.getAttribute("data-theme"))
		.not.toBe(initialTheme);
});

test("collapses the sidebar without horizontal document overflow", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.goto("/");

	await page.getByRole("button", { name: "Toggle sidebar" }).click();

	await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					document.documentElement.scrollWidth <=
					document.documentElement.clientWidth,
			),
		)
		.toBe(true);
});

test("keeps Pi sessions in the sidebar without a user-facing connect action", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.goto("/");

	await expect(
		page.getByRole("navigation", { name: "Pi sessions" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Connect|Disconnect/ }),
	).toHaveCount(0);
});

test("renders enriched collapsed tool call summaries", async ({ page }) => {
	await setupMockManager(page);

	await page.addInitScript(() => {
		const ctrl = (window as any).__mockControl__;
		const cmd =
			"npm test -- tests/sessionState.test.ts --long-summary-command-that-should-truncate-in-css";
		ctrl.sessions = [
			{
				id: "saved-1",
				title: "Saved session",
				status: "idle",
				sessionPath: "/tmp/pi/saved.jsonl",
				updatedAt: "2026-05-16T00:00:00.000Z",
			},
		];
		ctrl.snapshots["saved-1"] = {
			session: {
				id: "saved-1",
				title: "Saved session",
				status: "idle",
			},
			view: {
				session: {
					id: "saved-1",
					title: "Saved session",
					status: "idle",
				},
				items: [
					{
						kind: "assistant",
						id: "a1",
						content: [
							{ type: "text", text: "Done" },
							{
								type: "toolCall",
								id: "call_1",
								name: "bash",
								input: { command: cmd },
							},
						],
					},
					{
						kind: "tool",
						id: "call_1",
						toolName: "bash",
						toolLabel: "bash",
						input: { command: cmd },
						output: [{ type: "text", text: "ok" }],
						status: "done",
					},
				],
				status: "idle",
				statusText: "Session loaded",
				pendingRequests: [],
				extensionDraft: null,
				cursor: "",
			},
			streamCursor: "",
		};
	});

	await page.goto("/");
	await page
		.getByRole("button", { name: "Chat session: Saved session" })
		.click();

	const summary = page.locator(".tool-detail summary").first();
	await expect(summary).toContainText("bash");
	await expect(summary).toContainText("npm test");
	await expect(summary).toContainText("Complete");
	await expect(page.getByText("tool_call_delta")).toHaveCount(0);
	await expect(page.getByText("partial_json")).toHaveCount(0);

	const summaryText = summary.locator(".tool-summary-text");
	await expect
		.poll(() =>
			summaryText.evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					fontFamily: style.fontFamily,
					overflowX: style.overflowX,
					whiteSpace: style.whiteSpace,
				};
			}),
		)
		.toEqual(
			expect.objectContaining({ overflowX: "hidden", whiteSpace: "nowrap" }),
		);
	await expect(summaryText).toHaveCSS("font-family", /monospace/);
	await expect(summary.locator(".tool-summary-detail")).toHaveCSS(
		"text-overflow",
		"ellipsis",
	);

	const dot = summary.locator(".tool-status-dot");
	await expect(dot).toHaveAttribute("title", "Complete");
	await expect(dot).toHaveCSS("background-color", "rgb(34, 197, 94)");
});

test("renders streaming tool lifecycle events as styled tool details", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.goto("/");

	// Send a message to create a draft session
	await page.getByRole("textbox", { name: "Message prompt" }).fill("test");
	await page.getByRole("button", { name: "Send" }).click();

	// Wait for the session to be created
	await expect.poll(() => getCreatedSessions(page)).not.toHaveLength(0);
	const sessions = await getCreatedSessions(page);
	const sessionId = sessions[0]?.id;

	// Push streaming events
	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_start",
				message: { id: "assistant-1", role: "assistant" },
			},
		}),
	);
	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_update",
				message: { id: "assistant-1", role: "assistant" },
				assistantMessageEvent: {
					type: "text_delta",
					delta: "Let me inspect that.",
				},
			},
		}),
	);
	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: "pwd" },
			},
		}),
	);

	const toolDetail = page.locator(".tool-detail").first();
	await expect(toolDetail).toHaveCount(1);
	await expect(toolDetail.locator("summary")).toContainText("bash");
	await expect(toolDetail.locator("summary")).toContainText("pwd");
	await expect(toolDetail.locator("summary")).toContainText("In progress");
	await expect(toolDetail.locator(".tool-status-dot")).toHaveAttribute(
		"title",
		"In progress",
	);

	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "tool_execution_update",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: "pwd" },
				partialResult: {
					content: [{ type: "text", text: "running pwd\n" }],
				},
			},
		}),
	);
	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "tool_execution_end",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: "pwd" },
				result: {
					content: [{ type: "text", text: "/Users/agent/src/agent-web\n" }],
				},
				isError: false,
			},
		}),
	);

	await expect(page.getByText("Let me inspect that.")).toBeVisible();
	await expect(toolDetail).toHaveCount(1);
	await expect(toolDetail.locator("summary")).toContainText("bash");
	await expect(toolDetail.locator("summary")).toContainText("pwd");
	await expect(toolDetail.locator("summary")).toContainText("Complete");
	await expect(toolDetail.locator(".tool-status-dot")).toHaveAttribute(
		"title",
		"Complete",
	);
	await expect(toolDetail.locator("pre")).toContainText(
		"/Users/agent/src/agent-web",
	);
	await expect(page.getByText("Tool call")).toHaveCount(0);
	await expect(page.locator(".message-markdown").last()).not.toContainText(
		"running pwd",
	);
});

test("renders Verandah streams from view.patch and ignores duplicate legacy Pi events", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.goto("/");

	await page.getByRole("textbox", { name: "Message prompt" }).fill("test");
	await page.getByRole("button", { name: "Send" }).click();

	await expect.poll(() => getCreatedSessions(page)).not.toHaveLength(0);
	const sessions = await getCreatedSessions(page);
	const sessionId = sessions[0]?.id;

	await pushEvent(
		page,
		sessionId,
		streamEvent("view.patch", sessionId, {
			patches: [
				{
					type: "appendItem",
					item: {
						kind: "assistant",
						id: "patch-assistant",
						content: [{ type: "text", text: "Rendered from patch" }],
					},
				},
				{ type: "setStatus", status: "running", statusText: "Agent running" },
			],
			cursor: "1",
		}),
	);

	await expect(page.getByText("Rendered from patch")).toBeVisible();

	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_start",
				message: { id: "legacy-assistant", role: "assistant" },
			},
		}),
	);
	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_update",
				message: { id: "legacy-assistant", role: "assistant" },
				assistantMessageEvent: {
					type: "text_delta",
					delta: "Legacy duplicate",
				},
			},
		}),
	);

	await expect(page.getByText("Legacy duplicate")).toHaveCount(0);
	await expect(page.locator(".message-assistant")).toHaveCount(1);
});

test("renders streaming thinking and placeholder with the final message shape", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.goto("/");

	await page.getByRole("textbox", { name: "Message prompt" }).fill("test");
	await page.getByRole("button", { name: "Send" }).click();

	await expect.poll(() => getCreatedSessions(page)).not.toHaveLength(0);
	const sessions = await getCreatedSessions(page);
	const sessionId = sessions[0]?.id;

	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_start",
				message: { id: "assistant-thinking", role: "assistant" },
			},
		}),
	);

	const message = page.locator(".message-assistant").first();
	await expect(message).toHaveCount(1);
	await expect(message.locator(".message-shimmer")).toBeVisible();

	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_update",
				message: { id: "assistant-thinking", role: "assistant" },
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "Checking the reducer.",
				},
			},
		}),
	);

	const thinking = message.locator(".thinking").first();
	await expect(thinking).toHaveCount(1);
	await expect(thinking.locator("summary")).toContainText("Thinking");
	await expect(thinking.locator("pre")).toContainText("Checking the reducer.");
	await expect(message.locator(".message-shimmer")).toBeVisible();

	const sectionClassesWhileStreaming = await thinking.evaluate(
		(element) => element.className,
	);
	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_end",
				message: {
					id: "assistant-thinking",
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "Checking the reducer.",
						},
						{ type: "text", text: "Done." },
					],
				},
			},
		}),
	);

	await expect(message.locator(".thinking")).toHaveCount(1);
	await expect(message.locator(".thinking")).toHaveClass(
		sectionClassesWhileStreaming,
	);
	await expect(message.locator(".message-markdown")).toContainText("Done.");
	await expect(message.locator(".message-shimmer")).toHaveCount(0);
});

test("keeps the streaming placeholder visible when thinking and tools are hidden", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.addInitScript(() => {
		localStorage.setItem("agent-web-show-non-message-responses", "false");
	});
	await page.goto("/");

	await page.getByRole("textbox", { name: "Message prompt" }).fill("test");
	await page.getByRole("button", { name: "Send" }).click();

	await expect.poll(() => getCreatedSessions(page)).not.toHaveLength(0);
	const sessions = await getCreatedSessions(page);
	const sessionId = sessions[0]?.id;

	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_start",
				message: { id: "assistant-hidden", role: "assistant" },
			},
		}),
	);

	const message = page.locator(".message-assistant").first();
	await expect(message.locator(".message-shimmer")).toBeVisible();

	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_update",
				message: { id: "assistant-hidden", role: "assistant" },
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "Hidden thinking.",
				},
			},
		}),
	);

	await expect(page.locator(".message-assistant")).toHaveCount(1);
	await expect(message.locator(".message-shimmer")).toBeVisible();
	await expect(message.locator(".thinking")).toHaveCount(0);

	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "tool_execution_start",
				toolCallId: "call_hidden",
				toolName: "bash",
				args: { command: "pwd" },
			},
		}),
	);

	await expect(page.locator(".message-assistant")).toHaveCount(1);
	await expect(message.locator(".message-shimmer")).toBeVisible();
	await expect(message.locator(".tool-detail")).toHaveCount(0);
});

test("renders tool lifecycle events before the assistant message starts", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.goto("/");

	await page.getByRole("textbox", { name: "Message prompt" }).fill("test");
	await page.getByRole("button", { name: "Send" }).click();

	await expect.poll(() => getCreatedSessions(page)).not.toHaveLength(0);
	const sessions = await getCreatedSessions(page);
	const sessionId = sessions[0]?.id;

	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "tool_execution_start",
				toolCallId: "call_early",
				toolName: "bash",
				args: { command: "pwd" },
			},
		}),
	);

	const toolDetail = page.locator(".tool-detail").first();
	await expect(toolDetail).toHaveCount(1);
	await expect(toolDetail.locator("summary")).toContainText("bash");
	await expect(toolDetail.locator("summary")).toContainText("pwd");
	await expect(toolDetail.locator(".tool-status-dot")).toHaveAttribute(
		"title",
		"In progress",
	);

	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_start",
				message: { id: "assistant-early", role: "assistant" },
			},
		}),
	);
	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: {
				type: "message_update",
				message: { id: "assistant-early", role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "Checking." },
			},
		}),
	);

	await expect(page.getByText("Checking.")).toBeVisible();
	await expect(page.locator(".tool-detail")).toHaveCount(1);
	await expect(toolDetail.locator(".tool-status-dot")).toHaveAttribute(
		"title",
		"In progress",
	);
});

test("sends active-turn composer input as queued prompts", async ({ page }) => {
	await setupMockManager(page);
	await page.goto("/");

	// Create a draft session first
	await page.getByRole("textbox", { name: "Message prompt" }).fill("create me");
	await page.getByRole("button", { name: "Send" }).click();

	await expect.poll(() => getCreatedSessions(page)).not.toHaveLength(0);
	const sessions = await getCreatedSessions(page);
	const sessionId = sessions[0]?.id;

	// Push turn_start to simulate active turn
	await pushEvent(
		page,
		sessionId,
		streamEvent("pi.event", sessionId, {
			event: { type: "turn_start" },
		}),
	);

	// Now send another message while turn is active
	await page
		.getByRole("textbox", { name: "Message prompt" })
		.fill("Adjust this");
	await page.getByRole("button", { name: "Send" }).click();

	const sentMessages = await getSentMessages(page);
	const adjustMessage = sentMessages.find(
		(m: any) => m.message === "Adjust this",
	);
	expect(adjustMessage).toBeDefined();
	expect(adjustMessage.mode).toBe("steer");
	expect(adjustMessage.sessionId).toBe(sessionId);
});

test("draft session receives session ID on first send and routes subsequent messages", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.goto("/");

	// First send creates a draft
	await page
		.getByRole("textbox", { name: "Message prompt" })
		.fill("Start draft");
	await page.getByRole("button", { name: "Send" }).click();

	await expect.poll(() => getCreatedSessions(page)).not.toHaveLength(0);
	const created = await getCreatedSessions(page);
	const draftId = created[0]?.id;

	const sentMessages = await getSentMessages(page);
	const firstSend = sentMessages.find((m: any) => m.message === "Start draft");
	expect(firstSend).toBeDefined();
	expect(firstSend.sessionId).toBe(draftId);

	// Second send should use the same session ID
	await page
		.getByRole("textbox", { name: "Message prompt" })
		.fill("Still draft");
	await page.getByRole("button", { name: "Send" }).click();

	const sentMessages2 = await getSentMessages(page);
	const secondSend = sentMessages2.find(
		(m: any) => m.message === "Still draft",
	);
	expect(secondSend).toBeDefined();
	expect(secondSend.sessionId).toBe(draftId);
});

test("shows saved-session loading, metadata, and message copy controls", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.addInitScript(() => {
		const clipboardStore = { value: "" };
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					clipboardStore.value = text;
				},
				readText: async () => clipboardStore.value,
			},
		});
	});

	await page.addInitScript(() => {
		const ctrl = (window as any).__mockControl__;
		ctrl.sessions = [
			{
				id: "019e30bb-2c07-7633-97cf-47c7c8f8b114",
				title: "Saved polish chat",
				status: "idle",
				sessionPath: "/tmp/pi/saved-session.jsonl",
				updatedAt: "2026-05-16T00:00:00.000Z",
			},
		];
		ctrl.snapshots["019e30bb-2c07-7633-97cf-47c7c8f8b114"] = {
			session: {
				id: "019e30bb-2c07-7633-97cf-47c7c8f8b114",
				title: "Saved polish chat",
				status: "idle",
				sessionPath: "/tmp/pi/saved-session.jsonl",
			},
			view: {
				session: {
					id: "019e30bb-2c07-7633-97cf-47c7c8f8b114",
					title: "Saved polish chat",
					status: "idle",
					sessionPath: "/tmp/pi/saved-session.jsonl",
				},
				items: [
					{
						kind: "assistant",
						id: "a1",
						content: [{ type: "text", text: "Saved **answer**" }],
					},
				],
				status: "idle",
				statusText: "Session loaded",
				pendingRequests: [],
				extensionDraft: null,
				cursor: "",
			},
			state: {
				sessionId: "019e30bb-2c07-7633-97cf-47c7c8f8b114",
				provider: { id: "prov-1", name: "Anthropic" },
				model: {
					id: "model-1",
					name: "Claude Sonnet",
					api: { id: "api-1", name: "Anthropic API" },
				},
				status: "ready",
			},
			streamCursor: "",
		};
	});

	await page.goto("/");

	await page
		.getByRole("button", { name: "Chat session: Saved polish chat" })
		.click();

	await expect(page.getByText("Saved answer")).toBeVisible();
	await expect(page.locator(".profile-row")).not.toContainText("019e30bb");
	await expect(page.locator(".profile-row")).not.toContainText("Pi ready");

	await page.getByRole("button", { name: "Session details" }).click();
	const detailsDialog = page.getByRole("dialog", {
		name: "Session details",
	});
	await expect(detailsDialog).toBeVisible();
	await expect(detailsDialog).toBeFocused();
	await expect(detailsDialog.getByText("Provider")).toBeVisible();
	await expect(
		detailsDialog.getByText("Anthropic", { exact: true }),
	).toBeVisible();
	await expect(detailsDialog.getByText("Model")).toBeVisible();
	await expect(
		detailsDialog.getByText("Claude Sonnet", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("019e30bb-2c07-7633-97cf-47c7c8f8b114"),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(detailsDialog).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Session details" }),
	).toBeFocused();

	await page.getByRole("button", { name: "Copy message" }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("Saved **answer**");

	// Send a follow-up message
	await page.getByRole("textbox", { name: "Message prompt" }).fill("Follow up");
	await page.getByRole("button", { name: "Send" }).click();

	const sentMessages = await getSentMessages(page);
	const followUp = sentMessages.find((m: any) => m.message === "Follow up");
	expect(followUp).toBeDefined();
	expect(followUp.sessionId).toBe("019e30bb-2c07-7633-97cf-47c7c8f8b114");

	// Push an extension request
	await pushEvent(
		page,
		"019e30bb-2c07-7633-97cf-47c7c8f8b114",
		streamEvent(
			"user_request.created",
			"019e30bb-2c07-7633-97cf-47c7c8f8b114",
			{
				request: {
					type: "extension_ui_request",
					id: "ext-confirm",
					method: "confirm",
					params: {
						title: "Confirm action",
						message: "Continue?",
					},
				},
			},
		),
	);

	await page.getByRole("button", { name: "Confirm" }).click();

	const responses = await getExtensionResponses(page);
	const confirmResponse = responses.find(
		(r: any) => r.response.id === "ext-confirm",
	);
	expect(confirmResponse).toBeDefined();
	expect(confirmResponse.response.confirmed).toBe(true);
	expect(confirmResponse.sessionId).toBe(
		"019e30bb-2c07-7633-97cf-47c7c8f8b114",
	);
});

test("clears saved-session loading when opening fails", async ({ page }) => {
	await setupMockManager(page);

	await page.addInitScript(() => {
		const ctrl = (window as any).__mockControl__;
		ctrl.sessions = [
			{
				id: "019e30bb-2c07-7633-97cf-47c7c8f8b114",
				title: "Saved polish chat",
				status: "idle",
				sessionPath: "/tmp/pi/saved-session.jsonl",
			},
		];
		ctrl.openSessionErrors["019e30bb-2c07-7633-97cf-47c7c8f8b114"] =
			"missing session";
	});

	await page.goto("/");

	await page
		.getByRole("button", { name: "Chat session: Saved polish chat" })
		.click();

	await expect(
		page.getByRole("heading", { name: "Could not load session" }),
	).toBeVisible();
	await expect(
		page.getByText("Pi request failed: missing session"),
	).toBeVisible();
});

test("message copy button reports clipboard failure", async ({ page }) => {
	await setupMockManager(page);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async () => {
					throw new Error("blocked");
				},
			},
		});
		document.execCommand = () => false;
	});

	await page.addInitScript(() => {
		const ctrl = (window as any).__mockControl__;
		ctrl.sessions = [{ id: "copy-1", title: "Copy test", status: "idle" }];
		ctrl.snapshots["copy-1"] = {
			session: { id: "copy-1", title: "Copy test", status: "idle" },
			view: {
				session: { id: "copy-1", title: "Copy test", status: "idle" },
				items: [
					{
						kind: "assistant",
						id: "a1",
						content: [{ type: "text", text: "Copy me" }],
					},
				],
				status: "idle",
				statusText: "Session loaded",
				pendingRequests: [],
				extensionDraft: null,
				cursor: "",
			},
			streamCursor: "",
		};
	});

	await page.goto("/");

	await page.getByRole("button", { name: "Chat session: Copy test" }).click();
	await page.getByRole("button", { name: "Copy message" }).click();

	await expect(page.getByRole("button", { name: "Copy failed" })).toBeVisible();
});

test("grows the prompt for multiline input without a scrollbar for short content", async ({
	page,
}) => {
	await setupMockManager(page);
	await page.goto("/");

	const prompt = page.getByRole("textbox", { name: "Message prompt" });
	await expect(prompt).toHaveCSS("overflow-y", "hidden");

	await prompt.fill("Short message");
	await expect(prompt).toHaveCSS("overflow-y", "hidden");
	const oneLineHeight = (await prompt.boundingBox())?.height ?? 0;

	await prompt.fill(
		["Line one", "Line two", "Line three", "Line four"].join("\n"),
	);

	await expect
		.poll(
			async () => ((await prompt.boundingBox())?.height ?? 0) > oneLineHeight,
		)
		.toBe(true);
	await expect(prompt).toHaveCSS("overflow-y", "hidden");
});
