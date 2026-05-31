import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyViewPatch,
	createCsdViewAdapter,
	createEmptySessionView,
	csdSnapshotToView,
	piSnapshotToView,
	piStreamEventToPatch,
} from "../src/sessionProtocolEntry";
import type {
	AssistantMessageItem,
	ContentBlock,
	ConversationItem,
	SessionSummary,
	SessionView,
	ViewPatch,
} from "../src/sessionProtocolEntry";

describe("session-protocol entrypoint", () => {
	it("exports protocol types and adapters without pulling App.vue", () => {
		expect(applyViewPatch).toBeTypeOf("function");
		expect(createEmptySessionView).toBeTypeOf("function");
		expect(createCsdViewAdapter).toBeTypeOf("function");
		expect(csdSnapshotToView).toBeTypeOf("function");
		expect(piSnapshotToView).toBeTypeOf("function");
		expect(piStreamEventToPatch).toBeTypeOf("function");
	});

	it("createEmptySessionView works", () => {
		const view = createEmptySessionView({
			id: "s1",
			title: "Test",
			status: "idle",
		});
		expect(view.session.id).toBe("s1");
		expect(view.items).toHaveLength(0);
	});

	it("applyViewPatch appends items", () => {
		const view = createEmptySessionView();
		const item: ConversationItem = {
			kind: "user",
			id: "u1",
			content: [{ type: "text", text: "Hello" }],
		};
		const patch: ViewPatch = { type: "appendItem", item };
		const next = applyViewPatch(view, patch);
		expect(next.items).toHaveLength(1);
		expect(next.items[0].kind).toBe("user");
	});

	it("exports all required types at type level", () => {
		// These must compile — runtime values are undefined for type-only exports.
		const session: SessionSummary = { id: "x", title: "S", status: "idle" };
		expect(session.id).toBe("x");

		const msg: AssistantMessageItem = {
			kind: "assistant",
			id: "a1",
			content: [{ type: "text", text: "Hi" }],
		};
		expect(msg.kind).toBe("assistant");

		const block: ContentBlock = { type: "text", text: "ok" };
		expect(block.type).toBe("text");
	});

	it("session-protocol entrypoint source has no vue imports", () => {
		const srcPath = path.resolve(__dirname, "../src/sessionProtocolEntry.ts");
		const src = fs.readFileSync(srcPath, "utf-8");
		// Only check non-comment lines for actual imports
		const nonCommentLines = src
			.split("\n")
			.filter((line) => !line.trim().startsWith("*"))
			.filter((line) => !line.trim().startsWith("/"));
		const codeBody = nonCommentLines.join("\n");
		expect(codeBody).not.toMatch(/\.vue/);
		expect(codeBody).not.toMatch(/\.\/index/);
		expect(codeBody).not.toMatch(/App\.vue/);
	});

	it("session-protocol entrypoint source has no server imports", () => {
		const srcPath = path.resolve(__dirname, "../src/sessionProtocolEntry.ts");
		const src = fs.readFileSync(srcPath, "utf-8");
		expect(src).not.toMatch(/\.\.\/server/);
		expect(src).not.toMatch(/server\//);
	});
});
