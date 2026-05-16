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
      source: "pi",
      type: "response",
      response: {
        type: "response",
        command: "switch_session",
        success: false,
        error: { message: "missing session" }
      }
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
