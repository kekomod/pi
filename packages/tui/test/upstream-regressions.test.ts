import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { getScrollbarCellCacheStats, renderLayoutFrame } from "../src/layout.ts";
import type { Terminal } from "../src/terminal.ts";
import { encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CaptureTerminal implements Terminal {
	readonly writes: string[] = [];
	readonly columns = 80;
	readonly rows = 8;
	readonly kittyProtocolActive = true;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

interface TuiRenderSurface {
	altScreenActive: boolean;
	stopped: boolean;
	imageProtocol: "kitty" | null;
	requestRender(): void;
	doRender(): void;
}

function renderSurface(tui: TuiAltScreen): TuiRenderSurface {
	return tui as unknown as TuiRenderSurface;
}

describe("upstream TUI regressions", () => {
	it("keeps the scrollbar-cell cache bounded by entries and UTF-16 bytes", () => {
		let generation = 0;
		const content = {
			render: (width: number) => {
				const rows: string[] = [];
				for (let row = 0; row < 12; row++) {
					const prefix = `${generation}:${row}:`;
					rows.push(`${prefix}${"x".repeat(Math.max(0, width - prefix.length))}`);
				}
				return rows;
			},
			invalidate: () => {},
		};
		const scrollView = new ScrollView(content, { scrollbar: "always" });
		for (generation = 0; generation < 60; generation++) {
			renderLayoutFrame(scrollView, 2048, 12, () => {});
		}

		const after = getScrollbarCellCacheStats();
		assert.ok(after.bytes > 0);
		assert.ok(after.entries <= 1024);
		assert.ok(after.bytes <= 2 * 1024 * 1024);
	});

	it("repaints only affected registered Kitty image placements", () => {
		const terminal = new CaptureTerminal();
		const tui = new TuiAltScreen(terminal);
		const surface = renderSurface(tui);
		surface.altScreenActive = true;
		surface.stopped = false;
		surface.imageProtocol = "kitty";
		surface.requestRender = () => {};

		const firstImageId = 101;
		const secondImageId = 102;
		registerKittyImageMetadata({ imageId: firstImageId, columns: 1, rows: 1, widthPx: 1, heightPx: 1 });
		registerKittyImageMetadata({ imageId: secondImageId, columns: 1, rows: 1, widthPx: 1, heightPx: 1 });
		const first = encodeKitty("AAAA", { columns: 1, rows: 1, imageId: firstImageId, moveCursor: false });
		const second = encodeKitty("AAAA", { columns: 1, rows: 1, imageId: secondImageId, moveCursor: false });
		const rows = ["Title", "", `prefix ${first}`, "plain", `fixed ${second}`, "footer"];
		tui.setLayoutRoot({ render: () => rows, invalidate: () => {} });
		surface.doRender();
		terminal.writes.length = 0;

		rows[2] = `changed ${first}`;
		surface.doRender();
		let output = terminal.writes.join("");
		assert.strictEqual((output.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? []).length, 1);
		assert.ok(output.includes(`\x1b_Ga=d,d=i,i=${firstImageId},q=2\x1b\\`));
		assert.ok(!output.includes("d=a,"));
		assert.ok(!output.includes(`i=${secondImageId}`));
		assert.ok(!output.includes("a=T"));

		terminal.writes.length = 0;
		rows[3] = `second placement ${first}`;
		surface.doRender();
		output = terminal.writes.join("");
		assert.strictEqual(
			(output.match(/\x1b_Ga=p,q=2[^\x1b]*/g) ?? []).filter((line) => line.includes(`i=${firstImageId}`)).length,
			2,
		);

		terminal.writes.length = 0;
		rows[2] = "removed image";
		rows[3] = "removed other placement";
		surface.doRender();
		output = terminal.writes.join("");
		assert.ok(output.includes(`d=i,i=${firstImageId}`));
		assert.ok(!output.includes(`i=${secondImageId}`));

		terminal.writes.length = 0;
		surface.doRender();
		assert.strictEqual((terminal.writes.join("").match(/\x1b\[\d+;1H\x1b\[2K/g) ?? []).length, 0);
	});

	it("uses conservative redraws for unregistered and composed Kitty rows", () => {
		const terminal = new CaptureTerminal();
		const tui = new TuiAltScreen(terminal);
		const surface = renderSurface(tui);
		surface.altScreenActive = true;
		surface.stopped = false;
		surface.imageProtocol = "kitty";
		surface.requestRender = () => {};

		const imageId = 201;
		registerKittyImageMetadata({ imageId, columns: 1, rows: 1, widthPx: 1, heightPx: 1 });
		const registered = encodeKitty("AAAA", { columns: 1, rows: 1, imageId, moveCursor: false });
		const rows = ["title", registered, "body", "footer"];
		tui.setLayoutRoot({ render: () => rows, invalidate: () => {} });
		surface.doRender();
		terminal.writes.length = 0;

		rows[1] = "\x1b_Ga=T,f=100,i=999,q=2;AAAA\x1b\\";
		surface.doRender();
		let output = terminal.writes.join("");
		assert.ok(output.includes("d=a,"));
		assert.strictEqual((output.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? []).length, terminal.rows);

		terminal.writes.length = 0;
		rows[1] = `pair ${registered} ${registered}`;
		surface.doRender();
		output = terminal.writes.join("");
		assert.ok(output.includes("d=a,"));
		assert.strictEqual((output.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? []).length, terminal.rows);
	});

	it("exposes viewport input, wheel and render hooks without replacing native routing", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const input: string[] = [];
		let hookCalls = 0;
		const removeInput = tui.addViewportInputListener((data) => input.push(data));
		const removeHook = tui.addViewportRenderHook((screen, layout, width) => {
			hookCalls += 1;
			assert.strictEqual(layout.width, width);
			return screen.map((line, row) => (row === 0 ? `hook${line.slice(4)}` : line));
		});
		tui.setWheelScrollLines(3);
		tui.setLayoutRoot(new ScrollView(new Text("one\ntwo\nthree\nfour\nfive", 0, 0), { primary: true }));
		tui.start();
		await terminal.waitForRender();
		assert.ok(hookCalls > 0);
		assert.ok(
			terminal.getViewport().some((line) => line.includes("hook")),
			JSON.stringify(terminal.getViewport()),
		);

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(input, ["\x1b[<64;1;1M"]);

		removeInput();
		removeHook();
		const callsAfterRemove = hookCalls;
		tui.requestImmediateRender();
		await terminal.waitForRender();
		assert.strictEqual(hookCalls, callsAfterRemove);
		tui.stop();
	});
});
