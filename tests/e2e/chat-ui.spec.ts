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
