import { expect, test } from "@playwright/test";

test("loads the empty chat prompt", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Start a chat with Pi" })).toBeVisible();
  await expect(page.getByText("Send a prompt or open a saved session.")).toBeVisible();
});

test("cycles the theme on the document root", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("agent-web-theme", "light");
  });
  await page.goto("/");

  const root = page.locator("html");
  const initialTheme = await root.getAttribute("data-theme");
  await page.getByRole("button", { name: /^Theme:/ }).click();

  await expect.poll(() => root.getAttribute("data-theme")).not.toBe(initialTheme);
});

test("collapses the sidebar without horizontal document overflow", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Toggle sidebar" }).click();

  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    )
    .toBe(true);
});

test("keeps Pi sessions in the sidebar without a user-facing connect action", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("navigation", { name: "Pi sessions" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Connect|Disconnect/ })).toHaveCount(0);
});

test("renders enriched collapsed tool call summaries", async ({ page }) => {
  let wsRoute: { send: (message: string) => void } | undefined;

  await page.routeWebSocket("/rpc", (ws) => {
    wsRoute = ws;
    ws.onMessage((message) => {
      const payload = JSON.parse(typeof message === "string" ? message : message.toString()) as { command?: string };
      if (payload.command === "list_sessions") {
        ws.send(JSON.stringify({ source: "bridge", type: "sessions", sessions: [] }));
      }
    });
  });

  await page.goto("/");
  await expect.poll(() => Boolean(wsRoute)).toBe(true);

  const command = "npm test -- tests/sessionState.test.ts --long-summary-command-that-should-truncate-in-css";
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "response",
      response: {
        type: "response",
        command: "get_messages",
        success: true,
        data: {
          messages: [
            {
              id: "a1",
              role: "assistant",
              content: [
                { type: "text", text: "Done" },
                { type: "tool_call_delta", delta: { type: "input_json_delta", partial_json: "{\"command\"" } },
                { type: "toolCall", id: "call_1", name: "bash", arguments: { command } }
              ]
            },
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "bash",
              content: [{ type: "text", text: "ok" }],
              isError: false
            }
          ]
        }
      }
    })
  );

  const summary = page.locator(".tool-detail summary").first();
  await expect(summary).toContainText("bash");
  await expect(summary).toContainText(command);
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
          whiteSpace: style.whiteSpace
        };
      })
    )
    .toEqual(expect.objectContaining({ overflowX: "hidden", whiteSpace: "nowrap" }));
  await expect(summaryText).toHaveCSS("font-family", /monospace/);
  await expect(summary.locator(".tool-summary-detail")).toHaveCSS("text-overflow", "ellipsis");

  const dot = summary.locator(".tool-status-dot");
  await expect(dot).toHaveAttribute("title", "Complete");
  await expect(dot).toHaveCSS("background-color", "rgb(34, 197, 94)");
});

test("renders streaming tool lifecycle events as styled tool details", async ({ page }) => {
  let wsRoute: { send: (message: string) => void } | undefined;

  await page.routeWebSocket("/rpc", (ws) => {
    wsRoute = ws;
    ws.onMessage((message) => {
      const payload = JSON.parse(typeof message === "string" ? message : message.toString()) as { command?: string };
      if (payload.command === "list_sessions") {
        ws.send(JSON.stringify({ source: "bridge", type: "sessions", sessions: [] }));
      }
    });
  });

  await page.goto("/");
  await expect.poll(() => Boolean(wsRoute)).toBe(true);

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: { type: "message_start", message: { id: "assistant-1", role: "assistant" } }
    })
  );
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: {
        type: "message_update",
        message: { id: "assistant-1", role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "Let me inspect that." }
      }
    })
  );
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "pwd" }
      }
    })
  );

  const toolDetail = page.locator(".tool-detail").first();
  await expect(toolDetail).toHaveCount(1);
  await expect(toolDetail.locator("summary")).toContainText("bash");
  await expect(toolDetail.locator("summary")).toContainText("pwd");
  await expect(toolDetail.locator("summary")).toContainText("In progress");
  await expect(toolDetail.locator(".tool-status-dot")).toHaveAttribute("title", "In progress");

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: {
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "pwd" },
        partialResult: { content: [{ type: "text", text: "running pwd\n" }] }
      }
    })
  );
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "pwd" },
        result: { content: [{ type: "text", text: "/Users/agent/src/agent-web\n" }] },
        isError: false
      }
    })
  );

  await expect(page.getByText("Let me inspect that.")).toBeVisible();

  await expect(toolDetail).toHaveCount(1);
  await expect(toolDetail.locator("summary")).toContainText("bash");
  await expect(toolDetail.locator("summary")).toContainText("pwd");
  await expect(toolDetail.locator("summary")).toContainText("Complete");
  await expect(toolDetail.locator(".tool-status-dot")).toHaveAttribute("title", "Complete");
  await expect(toolDetail.locator("pre")).toContainText("/Users/agent/src/agent-web");
  await expect(page.getByText("Tool call")).toHaveCount(0);
  await expect(page.locator(".message-markdown")).not.toContainText("running pwd");
});

test("renders streaming thinking and placeholder with the final message shape", async ({ page }) => {
  let wsRoute: { send: (message: string) => void } | undefined;

  await page.routeWebSocket("/rpc", (ws) => {
    wsRoute = ws;
    ws.onMessage((message) => {
      const payload = JSON.parse(typeof message === "string" ? message : message.toString()) as { command?: string };
      if (payload.command === "list_sessions") {
        ws.send(JSON.stringify({ source: "bridge", type: "sessions", sessions: [] }));
      }
    });
  });

  await page.goto("/");
  await expect.poll(() => Boolean(wsRoute)).toBe(true);

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: { type: "message_start", message: { id: "assistant-thinking", role: "assistant" } }
    })
  );

  const message = page.locator(".message-assistant").first();
  await expect(message).toHaveCount(1);
  await expect(message.locator(".message-shimmer")).toBeVisible();

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: {
        type: "message_update",
        message: { id: "assistant-thinking", role: "assistant" },
        assistantMessageEvent: { type: "thinking_delta", delta: "Checking the reducer." }
      }
    })
  );

  const thinking = message.locator(".thinking").first();
  await expect(thinking).toHaveCount(1);
  await expect(thinking.locator("summary")).toContainText("Thinking");
  await expect(thinking.locator("pre")).toContainText("Checking the reducer.");
  await expect(message.locator(".message-shimmer")).toBeVisible();

  const sectionClassesWhileStreaming = await thinking.evaluate((element) => element.className);
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: {
        type: "message_end",
        message: {
          id: "assistant-thinking",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Checking the reducer." },
            { type: "text", text: "Done." }
          ]
        }
      }
    })
  );

  await expect(message.locator(".thinking")).toHaveCount(1);
  await expect(message.locator(".thinking")).toHaveClass(sectionClassesWhileStreaming);
  await expect(message.locator(".message-markdown")).toContainText("Done.");
  await expect(message.locator(".message-shimmer")).toHaveCount(0);
});

test("keeps the streaming placeholder visible when thinking and tools are hidden", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("agent-web-show-non-message-responses", "false");
  });

  let wsRoute: { send: (message: string) => void } | undefined;

  await page.routeWebSocket("/rpc", (ws) => {
    wsRoute = ws;
    ws.onMessage((message) => {
      const payload = JSON.parse(typeof message === "string" ? message : message.toString()) as { command?: string };
      if (payload.command === "list_sessions") {
        ws.send(JSON.stringify({ source: "bridge", type: "sessions", sessions: [] }));
      }
    });
  });

  await page.goto("/");
  await expect.poll(() => Boolean(wsRoute)).toBe(true);

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: { type: "message_start", message: { id: "assistant-hidden", role: "assistant" } }
    })
  );
  const message = page.locator(".message-assistant").first();
  await expect(message.locator(".message-shimmer")).toBeVisible();

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: {
        type: "message_update",
        message: { id: "assistant-hidden", role: "assistant" },
        assistantMessageEvent: { type: "thinking_delta", delta: "Hidden thinking." }
      }
    })
  );
  await expect(page.locator(".message-assistant")).toHaveCount(1);
  await expect(message.locator(".message-shimmer")).toBeVisible();
  await expect(message.locator(".thinking")).toHaveCount(0);

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: {
        type: "tool_execution_start",
        toolCallId: "call_hidden",
        toolName: "bash",
        args: { command: "pwd" }
      }
    })
  );
  await expect(page.locator(".message-assistant")).toHaveCount(1);
  await expect(message.locator(".message-shimmer")).toBeVisible();
  await expect(message.locator(".tool-detail")).toHaveCount(0);
});

test("renders tool lifecycle events before the assistant message starts", async ({ page }) => {
  let wsRoute: { send: (message: string) => void } | undefined;

  await page.routeWebSocket("/rpc", (ws) => {
    wsRoute = ws;
    ws.onMessage((message) => {
      const payload = JSON.parse(typeof message === "string" ? message : message.toString()) as { command?: string };
      if (payload.command === "list_sessions") {
        ws.send(JSON.stringify({ source: "bridge", type: "sessions", sessions: [] }));
      }
    });
  });

  await page.goto("/");
  await expect.poll(() => Boolean(wsRoute)).toBe(true);

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: {
        type: "tool_execution_start",
        toolCallId: "call_early",
        toolName: "bash",
        args: { command: "pwd" }
      }
    })
  );

  const toolDetail = page.locator(".tool-detail").first();
  await expect(toolDetail).toHaveCount(1);
  await expect(toolDetail.locator("summary")).toContainText("bash");
  await expect(toolDetail.locator("summary")).toContainText("pwd");
  await expect(toolDetail.locator(".tool-status-dot")).toHaveAttribute("title", "In progress");

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: { type: "message_start", message: { id: "assistant-early", role: "assistant" } }
    })
  );
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: {
        type: "message_update",
        message: { id: "assistant-early", role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "Checking." }
      }
    })
  );

  await expect(page.getByText("Checking.")).toBeVisible();
  await expect(page.locator(".tool-detail")).toHaveCount(1);
  await expect(toolDetail.locator(".tool-status-dot")).toHaveAttribute("title", "In progress");
});

test("sends active-turn composer input as queued prompts", async ({ page }) => {
  const commands: { command?: string; payload?: unknown }[] = [];
  let wsRoute: { send: (message: string) => void } | undefined;

  await page.routeWebSocket("/rpc", (ws) => {
    wsRoute = ws;
    ws.onMessage((message) => {
      const payload = JSON.parse(typeof message === "string" ? message : message.toString()) as {
        command?: string;
        payload?: unknown;
      };
      commands.push(payload);
      if (payload.command === "list_sessions") {
        ws.send(JSON.stringify({ source: "bridge", type: "sessions", sessions: [] }));
      }
    });
  });

  await page.goto("/");
  await expect.poll(() => Boolean(wsRoute)).toBe(true);
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "event",
      event: { type: "turn_start" }
    })
  );

  await page.getByRole("textbox", { name: "Message prompt" }).fill("Adjust this");
  await page.getByRole("button", { name: "Send" }).click();

  await expect
    .poll(() => commands.find((entry) => entry.command === "prompt" && (entry.payload as { message?: string })?.message === "Adjust this"))
    .toEqual({
      type: "command",
      command: "prompt",
      payload: { message: "Adjust this", queueMode: "steer" }
    });
  expect(commands).not.toContainEqual(expect.objectContaining({ command: "steer" }));
  expect(commands).not.toContainEqual(expect.objectContaining({ command: "follow_up" }));
});

test("binds draft chat only from an authoritative saved-session response", async ({ page }) => {
  const commands: { command?: string; payload?: unknown }[] = [];
  let wsRoute: { send: (message: string) => void } | undefined;
  const sessionPath = "/tmp/pi/draft-session.jsonl";

  await page.routeWebSocket("/rpc", (ws) => {
    wsRoute = ws;
    ws.onMessage((message) => {
      const payload = JSON.parse(typeof message === "string" ? message : message.toString()) as {
        command?: string;
        payload?: unknown;
      };
      commands.push(payload);
      if (payload.command === "list_sessions") {
        ws.send(JSON.stringify({ source: "bridge", type: "sessions", sessions: [] }));
      }
    });
  });

  await page.goto("/");
  await expect.poll(() => Boolean(wsRoute)).toBe(true);

  await page.getByRole("textbox", { name: "Message prompt" }).fill("Start draft");
  await page.getByRole("button", { name: "Send" }).click();

  await expect
    .poll(() => commands.find((entry) => entry.command === "prompt" && (entry.payload as { message?: string })?.message === "Start draft"))
    .toEqual({
      type: "command",
      command: "prompt",
      payload: { message: "Start draft", queueMode: "steer" }
    });

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      sessionPath: "/tmp/pi/old.jsonl",
      type: "event",
      event: { type: "message_start", role: "assistant" }
    })
  );
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      sessionPath: "/tmp/pi/old.jsonl",
      type: "response",
      response: {
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ id: "old", role: "assistant", content: "Old saved answer" }] }
      }
    })
  );

  await expect(page.getByText("Old saved answer")).toHaveCount(0);

  await page.getByRole("textbox", { name: "Message prompt" }).fill("Still draft");
  await page.getByRole("button", { name: "Send" }).click();

  await expect
    .poll(() => commands.find((entry) => entry.command === "prompt" && (entry.payload as { message?: string })?.message === "Still draft"))
    .toEqual({
      type: "command",
      command: "prompt",
      payload: { message: "Still draft", queueMode: "steer" }
    });

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      sessionPath,
      type: "response",
      response: {
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "draft-session-id",
          sessionFile: sessionPath,
          sessionName: "Draft session"
        }
      }
    })
  );
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      sessionPath,
      type: "response",
      response: {
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ id: "a1", role: "assistant", content: "Bound draft answer" }] }
      }
    })
  );

  await expect(page.getByText("Bound draft answer")).toBeVisible();

  await page.getByRole("textbox", { name: "Message prompt" }).fill("Follow up");
  await page.getByRole("button", { name: "Send" }).click();

  await expect
    .poll(() => commands.find((entry) => entry.command === "prompt" && (entry.payload as { message?: string })?.message === "Follow up"))
    .toEqual({
      type: "command",
      command: "prompt",
      payload: { message: "Follow up", queueMode: "steer", sessionPath }
    });
});

test("shows saved-session loading, metadata, and message copy controls", async ({ page }) => {
  await page.addInitScript(() => {
    const clipboardStore = { value: "" };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          clipboardStore.value = text;
        },
        readText: async () => clipboardStore.value
      }
    });
  });

  let wsRoute: { send: (message: string) => void } | undefined;
  let openSessionSeen = false;
  let promptPayload: unknown;
  let extensionResponsePayload: unknown;

  await page.routeWebSocket("/rpc", (ws) => {
    wsRoute = ws;
    ws.onMessage((message) => {
      const payload = JSON.parse(typeof message === "string" ? message : message.toString()) as {
        command?: string;
        payload?: unknown;
      };
      if (payload.command === "list_sessions") {
        ws.send(
          JSON.stringify({
            source: "bridge",
            type: "sessions",
            sessions: [
              {
                id: "019e30bb-2c07-7633-97cf-47c7c8f8b114",
                path: "/tmp/pi/saved-session.jsonl",
                title: "Saved polish chat",
                modified: "2026-05-16T00:00:00.000Z"
              }
            ]
          })
        );
      }
      if (payload.command === "open_session") {
        openSessionSeen = true;
      }
      if (payload.command === "prompt") {
        promptPayload = payload.payload;
      }
      if (payload.command === "extension_ui_response") {
        extensionResponsePayload = payload.payload;
      }
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat session: Saved polish chat" }).click();

  await expect.poll(() => openSessionSeen).toBe(true);
  await expect(page.getByRole("heading", { name: "Loading session" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Start a chat with Pi" })).toBeHidden();

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      sessionPath: "/tmp/pi/saved-session.jsonl",
      type: "response",
      response: {
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ id: "a1", role: "assistant", content: "Saved **answer**" }] }
      }
    })
  );
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      sessionPath: "/tmp/pi/saved-session.jsonl",
      type: "response",
      response: {
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "019e30bb-2c07-7633-97cf-47c7c8f8b114",
          provider: { id: "019e30bb-2c07-7633-97cf-47c7c8f8b115", name: "Anthropic" },
          model: {
            id: "019e30bb-2c07-7633-97cf-47c7c8f8b116",
            name: "Claude Sonnet",
            api: { id: "019e30bb-2c07-7633-97cf-47c7c8f8b117", name: "Anthropic API" }
          },
          status: "ready"
        }
      }
    })
  );

  await expect(page.getByText("Saved answer")).toBeVisible();
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      sessionPath: "/tmp/pi/other-session.jsonl",
      type: "response",
      response: {
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ id: "other", role: "assistant", content: "Other session answer" }] }
      }
    })
  );
  await expect(page.getByText("Other session answer")).toHaveCount(0);
  await expect(page.getByText("Saved answer")).toBeVisible();
  await expect(page.locator(".profile-row")).not.toContainText("019e30bb");
  await expect(page.locator(".profile-row")).not.toContainText("Pi ready");

  await page.getByRole("button", { name: "Session details" }).click();
  const detailsDialog = page.getByRole("dialog", { name: "Session details" });
  await expect(detailsDialog).toBeVisible();
  await expect(detailsDialog).toBeFocused();
  await expect(detailsDialog.getByText("Provider")).toBeVisible();
  await expect(detailsDialog.getByText("Anthropic", { exact: true })).toBeVisible();
  await expect(detailsDialog.getByText("Model")).toBeVisible();
  await expect(detailsDialog.getByText("Claude Sonnet", { exact: true })).toBeVisible();
  await expect(page.getByText("019e30bb-2c07-7633-97cf-47c7c8f8b114")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detailsDialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Session details" })).toBeFocused();

  await page.getByRole("button", { name: "Copy message" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Saved **answer**");

  await page.getByRole("textbox", { name: "Message prompt" }).fill("Follow up");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => promptPayload).toEqual({
    message: "Follow up",
    queueMode: "steer",
    sessionPath: "/tmp/pi/saved-session.jsonl"
  });

  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      sessionPath: "/tmp/pi/saved-session.jsonl",
      type: "event",
      event: {
        type: "extension_ui_request",
        id: "ext-confirm",
        method: "confirm",
        params: { title: "Confirm action", message: "Continue?" }
      }
    })
  );
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => extensionResponsePayload).toEqual({
    id: "ext-confirm",
    confirmed: true,
    sessionPath: "/tmp/pi/saved-session.jsonl"
  });
});

test("clears saved-session loading when opening fails", async ({ page }) => {
  let wsRoute: { send: (message: string) => void } | undefined;

  await page.routeWebSocket("/rpc", (ws) => {
    wsRoute = ws;
    ws.onMessage((message) => {
      const payload = JSON.parse(typeof message === "string" ? message : message.toString()) as { command?: string };
      if (payload.command === "list_sessions") {
        ws.send(
          JSON.stringify({
            source: "bridge",
            type: "sessions",
            sessions: [
              {
                id: "019e30bb-2c07-7633-97cf-47c7c8f8b114",
                path: "/tmp/pi/saved-session.jsonl",
                title: "Saved polish chat"
              }
            ]
          })
        );
      }
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat session: Saved polish chat" }).click();
  await expect(page.getByRole("heading", { name: "Loading session" })).toBeVisible();

  wsRoute?.send(
    JSON.stringify({
      source: "bridge",
      type: "error",
      message: "missing session"
    })
  );

  await expect(page.getByRole("heading", { name: "Loading session" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Could not load session" })).toBeVisible();
  await expect(page.getByText("Pi request failed: missing session")).toBeVisible();
});

test("message copy button reports clipboard failure", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("blocked");
        }
      }
    });
    document.execCommand = () => false;
  });

  let wsRoute: { send: (message: string) => void } | undefined;

  await page.routeWebSocket("/rpc", (ws) => {
    wsRoute = ws;
    ws.onMessage((message) => {
      const payload = JSON.parse(typeof message === "string" ? message : message.toString()) as { command?: string };
      if (payload.command === "list_sessions") {
        ws.send(JSON.stringify({ source: "bridge", type: "sessions", sessions: [] }));
      }
    });
  });

  await page.goto("/");
  wsRoute?.send(
    JSON.stringify({
      source: "pi",
      type: "response",
      response: {
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ id: "a1", role: "assistant", content: "Copy me" }] }
      }
    })
  );

  await page.getByRole("button", { name: "Copy message" }).click();
  await expect(page.getByRole("button", { name: "Copy failed" })).toBeVisible();
});

test("grows the prompt for multiline input without a scrollbar for short content", async ({ page }) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "Message prompt" });
  await expect(prompt).toHaveCSS("overflow-y", "hidden");

  await prompt.fill("Short message");
  await expect(prompt).toHaveCSS("overflow-y", "hidden");
  const oneLineHeight = (await prompt.boundingBox())?.height ?? 0;

  await prompt.fill(["Line one", "Line two", "Line three", "Line four"].join("\n"));

  await expect.poll(async () => ((await prompt.boundingBox())?.height ?? 0) > oneLineHeight).toBe(true);
  await expect(prompt).toHaveCSS("overflow-y", "hidden");
});
