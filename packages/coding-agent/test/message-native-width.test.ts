import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
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

class WidthObserver extends Container {
	readonly renderWidths: number[] = [];
	readonly mouseWidths: number[] = [];
	text = "link";

	override render(width: number): string[] {
		this.renderWidths.push(width);
		return [this.text.padEnd(width)];
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		this.mouseWidths.push(event.width);
		return {
			handled: true,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}
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

	test("caches the width decision until native content is invalidated", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			assistant("A long sentence must reserve this width before it wraps across the transcript."),
		);
		let probes = 0;
		let firstProbe: readonly string[] | undefined;
		const resolver = ({ width, nativeLines }: { width: number; nativeLines: readonly string[] }) => {
			probes += 1;
			if (firstProbe === undefined) firstProbe = nativeLines;
			else expect(nativeLines).toBe(firstProbe);
			return reserveWhenLong(width, nativeLines);
		};
		component.setNativeRenderWidth(resolver, { cacheProbe: true });
		const first = component.render(40);
		const second = component.render(40);
		expect(second).toEqual(first);
		expect(probes).toBe(2);
		component.invalidate();
		component.render(40);
		expect(probes).toBe(3);
		component.setNativeRenderWidth(resolver, { cacheProbe: true });
		component.render(40);
		expect(probes).toBe(4);
	});

	test("reuses the narrow native render and padded rows when probe caching is enabled", () => {
		initTheme("dark");
		const observer = new WidthObserver();
		const component = new AssistantMessageComponent(assistant("answer"));
		component.addLeadingComponent(() => observer);
		component.setNativeRenderWidth(({ width }) => width - 8, { cacheProbe: true });

		const first = component.render(40);
		const second = component.render(40);
		expect(second).toBe(first);
		expect(observer.renderWidths).toEqual([40, 32]);

		observer.text = "updated";
		component.invalidate();
		const updated = stripAnsi(component.render(40).join("\n"));
		expect(updated).toContain("updated");
		expect(observer.renderWidths).toEqual([40, 32, 40, 32]);
	});

	test("rechecks a changed reservation at the same width", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			assistant("A long sentence must reserve this width before it wraps across the transcript."),
		);
		let reserve = true;
		component.setNativeRenderWidth(({ width }) => (reserve ? width - 8 : undefined));
		const narrowed = component.render(40);
		reserve = false;
		const full = component.render(40);
		expect(full).not.toEqual(narrowed);
		expect(full.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("rebuilds native geometry when a reservation expands at the same width", () => {
		initTheme("dark");
		const observer = new WidthObserver();
		const component = new AssistantMessageComponent(assistant("answer"));
		component.addLeadingComponent(() => observer);
		let reserve = true;
		component.setNativeRenderWidth(({ width }) => (reserve ? width - 8 : undefined));
		const narrowed = component.render(40);
		reserve = false;
		const full = component.render(40);
		expect(narrowed.length).toBeGreaterThan(0);
		expect(full.length).toBeGreaterThan(0);
		expect(observer.renderWidths.slice(-2)).toEqual([32, 40]);
		component.handleMouse({
			type: "click",
			button: "left",
			x: 1,
			y: 1,
			screenX: 1,
			screenY: 1,
			width: 40,
			height: full.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		});
		expect(observer.mouseWidths).toEqual([40]);
	});

	test("keeps uncoupled native rendering live on repeated frames", () => {
		initTheme("dark");
		const observer = new WidthObserver();
		const component = new AssistantMessageComponent(assistant("answer"));
		component.addLeadingComponent(() => observer);
		component.render(40);
		component.render(40);
		expect(observer.renderWidths.slice(-2)).toEqual([40, 40]);
	});

	test("keeps dynamic native children live when probe caching is not requested", () => {
		initTheme("dark");
		const observer = new WidthObserver();
		const component = new AssistantMessageComponent(assistant("answer"));
		component.addLeadingComponent(() => observer);
		component.setNativeRenderWidth(() => undefined);

		observer.text = "first frame";
		const first = stripAnsi(component.render(40).join("\n"));
		observer.text = "second frame";
		const second = stripAnsi(component.render(40).join("\n"));

		expect(first).toContain("first frame");
		expect(second).toContain("second frame");
		expect(observer.renderWidths.slice(-2)).toEqual([40, 40]);
	});

	test("measures changed native children before resolving a reduced width", () => {
		initTheme("dark");
		const observer = new WidthObserver();
		const component = new AssistantMessageComponent(assistant("answer"));
		component.addLeadingComponent(() => observer);
		component.setNativeRenderWidth(({ width, nativeLines }) =>
			nativeLines.join(" ").includes("reserve this width") ? width - 8 : undefined,
		);

		observer.text = "reserve this width";
		component.render(40);
		observer.text = "no reservation";
		const full = stripAnsi(component.render(40).join("\n"));

		expect(full).toContain("no reservation");
		expect(observer.renderWidths.slice(-3)).toEqual([40, 32, 40]);
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

	test("uses the native user background when padding a reserved row", () => {
		initTheme("dark");
		const component = new UserMessageComponent("A long sentence must reserve this width.");
		component.setNativeRenderWidth(({ width }) => width - 8);
		const lines = component.render(40);
		expect(lines.some((line) => line.includes("\x1b["))).toBe(true);
		expect(lines.some((line) => line.includes("\x1b[49m"))).toBe(true);
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
