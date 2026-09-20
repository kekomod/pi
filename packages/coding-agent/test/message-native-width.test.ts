import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function reserveWhenLong(width: number, nativeLines: readonly string[]): number | undefined {
	return nativeLines.join(" ").replace(/\s+/gu, " ").includes("reserve this width") ? width - 8 : undefined;
}

describe("native message width reservation", () => {
	test("rerenders long assistant content narrowly and pads rows to the outer width", () => {
		initTheme("dark");
		const message = assistant("A long sentence must reserve this width before it wraps across the transcript.");
		const baseline = new AssistantMessageComponent(message).render(40);
		let calls = 0;
		const component = new AssistantMessageComponent(message);
		component.setNativeRenderWidth(({ width, nativeLines }) => {
			calls += 1;
			return reserveWhenLong(width, nativeLines);
		});

		const lines = component.render(40);
		expect(calls).toBe(1);
		expect(lines[1]).not.toBe(baseline[1]);
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);
		expect(stripAnsi(lines.join("\n")).replace(/\s+/gu, " ")).toContain("reserve this width");
	});

	test("keeps short messages at the original width and handles Unicode narrow layouts", () => {
		initTheme("dark");
		const short = new UserMessageComponent("short");
		const shortNative = new UserMessageComponent("short");
		short.setNativeRenderWidth(({ width, nativeLines }) => reserveWhenLong(width, nativeLines));
		shortNative.setNativeRenderWidth(() => undefined);
		expect(short.render(40)).toEqual(shortNative.render(40));

		const unicode = new UserMessageComponent("日本語 🙂 reserve this width 日本語 🙂");
		unicode.setNativeRenderWidth(({ width, nativeLines }) => reserveWhenLong(width, nativeLines));
		const lines = unicode.render(16);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= 16)).toBe(true);
	});

	test("passes the reserved width to native mouse layout", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(assistantWithThinking());
		component.setNativeRenderWidth(({ width }) => width - 8);
		const lines = component.render(40);
		const row = lines.findIndex((line) => stripAnsi(line).includes("private reasoning"));
		expect(row).toBeGreaterThanOrEqual(0);
		expect(
			component.handleMouse({
				type: "click",
				button: "left",
				x: 1,
				y: row,
				screenX: 1,
				screenY: row,
				width: 40,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			})?.handled,
		).toBe(true);
	});
});

function assistantWithThinking(): AssistantMessage {
	return {
		...assistant("answer"),
		content: [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text: "answer" },
		],
	};
}
