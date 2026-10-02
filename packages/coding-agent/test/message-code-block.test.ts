import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	getCapabilities,
	Image,
	type MarkdownCodeBlockRenderContext,
	setCapabilities,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const source = "Before\n\n```preview\nstored source\n```\n\nAfter";

function assistant(): AssistantMessageComponent {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: source }],
		api: "openai-responses",
		provider: "openai",
		model: "synthetic",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	return new AssistantMessageComponent(message);
}

describe.each(["user", "assistant"] as const)("%s asynchronous Markdown blocks", (role) => {
	test("refreshes cached native geometry and dispatches clicks without changing stored text", async () => {
		initTheme("dark");
		const message = role === "user" ? new UserMessageComponent(source) : assistant();
		const original = JSON.stringify(message.message);
		let context: MarkdownCodeBlockRenderContext | undefined;
		let ready = false;
		let clicked = false;
		let redraws = 0;
		let overlay = false;
		message.setMarkdownRuntime(
			() => {
				redraws++;
			},
			() => overlay,
		);
		message.setNativeRenderWidth(({ width }) => width - 6, { cacheProbe: true });
		const component: Component = {
			invalidate() {},
			render: () =>
				clicked
					? ["Source view"]
					: ready
						? ["Preview", context?.hasOverlay() ? "" : "Visible pixels", "Last preview row"]
						: ["Pending"],
			handleMouse: (event) => {
				if (event.y !== 0) return undefined;
				clicked = true;
				context?.refresh();
				return { handled: true, render: true };
			},
		};
		const dispose = message.addRegionPresentation(() => ({
			markdownOptions: {
				renderCodeBlock: (value) => {
					context = value;
					return component;
				},
			},
		}));
		const pending = message.render(50);
		expect(stripAnsi(pending.join("\n"))).toContain("Pending");
		await Promise.resolve();
		ready = true;
		context?.refresh();
		expect(redraws).toBe(1);
		const preview = message.render(50);
		expect(preview.length).toBe(pending.length + 2);
		expect(stripAnsi(preview.join("\n"))).toContain("Visible pixels");
		const row = preview.findIndex((line) => stripAnsi(line).includes("Preview"));
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 1,
			y: row,
			screenX: 1,
			screenY: row,
			width: 50,
			height: preview.length,
			shift: false,
			alt: false,
			ctrl: false,
		};
		expect(message.handleMouse(event)?.handled).toBe(true);
		expect(stripAnsi(message.render(50).join("\n"))).toContain("Source view");
		expect(redraws).toBe(2);
		clicked = false;
		overlay = true;
		expect(stripAnsi(message.render(50).join("\n"))).not.toContain("Visible pixels");
		overlay = false;
		expect(stripAnsi(message.render(50).join("\n"))).toContain("Visible pixels");
		expect(JSON.stringify(message.message)).toBe(original);
		dispose();
		const restored = stripAnsi(message.render(50).join("\n"));
		expect(restored).toContain("stored source");
		expect(restored).not.toContain("Preview");
	});
});

test("assistant width padding preserves native image continuation rows", () => {
	initTheme("dark");
	const capabilities = getCapabilities();
	setCapabilities({ ...capabilities, images: "kitty" });
	try {
		const message = assistant();
		const image = new Image(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
			"image/png",
			{ fallbackColor: (value) => value },
			{ maxHeightCells: 6 },
			{ widthPx: 400, heightPx: 800 },
		);
		message.setNativeRenderWidth(({ width }) => width - 6, { cacheProbe: true });
		message.addRegionPresentation(() => ({ markdownOptions: { renderCodeBlock: () => image } }));
		const rows = message.render(50);
		const imageRow = rows.findIndex((row) => row.includes("\x1b_G"));
		expect(imageRow).toBeGreaterThanOrEqual(0);
		expect(rows[imageRow + 1]).toBe("");
	} finally {
		setCapabilities(capabilities);
	}
});
