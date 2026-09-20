import { isViewportTUI, type TUI, TuiAltScreen, TuiMainScreen, type ViewportTUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import {
	createInteractiveTuiReference,
	rebindInteractiveTuiReference,
} from "../../../src/modes/interactive/interactive-mode.ts";

describe("TUI method wrapping", () => {
	it("calls the method captured before a replacement", () => {
		const renderer = {
			render: (width: number) => [`width: ${width}`],
		} as unknown as TUI;
		const tui = createInteractiveTuiReference(() => renderer);
		const originalRender = tui.render;
		tui.render = (width: number) => originalRender(width);

		expect(tui.render(80)).toEqual(["width: 80"]);
	});

	it("routes a captured method to a replacement renderer", () => {
		const regularRequestRender = vi.fn();
		const fullscreenRequestRender = vi.fn();
		let renderer = { requestRender: regularRequestRender } as unknown as TUI;
		const tui = createInteractiveTuiReference(() => renderer);
		const requestRender = tui.requestRender;

		requestRender();
		renderer = { requestRender: fullscreenRequestRender } as unknown as TUI;
		requestRender();

		expect(regularRequestRender).toHaveBeenCalledOnce();
		expect(fullscreenRequestRender).toHaveBeenCalledOnce();
	});

	it("rebinds viewport listeners and wheel settings after renderer replacement", () => {
		const regularSetWheel = vi.fn();
		const fullscreenAddInput = vi.fn(() => vi.fn());
		const fullscreenAddRender = vi.fn(() => vi.fn());
		const fullscreenSetWheel = vi.fn();
		const regular = {
			addViewportInputListener: undefined,
			addViewportRenderHook: undefined,
			setWheelScrollLines: regularSetWheel,
		} as unknown as TUI;
		const fullscreen = {
			addViewportInputListener: fullscreenAddInput,
			addViewportRenderHook: fullscreenAddRender,
			addInputListener: vi.fn(() => () => {}),
			setWheelScrollLines: fullscreenSetWheel,
		} as unknown as TUI;
		let renderer = fullscreen;
		const tui = createInteractiveTuiReference(() => renderer) as TUI &
			Pick<ViewportTUI, "addViewportInputListener" | "addViewportRenderHook" | "setWheelScrollLines">;
		const viewportInput = vi.fn();
		const viewportRender = vi.fn();

		const stopInput = tui.addViewportInputListener(viewportInput);
		const stopRender = tui.addViewportRenderHook(viewportRender);
		tui.setWheelScrollLines(4);
		renderer = regular;
		rebindInteractiveTuiReference(tui);

		expect(fullscreenAddInput.mock.results[0]?.value).toHaveBeenCalledOnce();
		expect(fullscreenAddRender.mock.results[0]?.value).toHaveBeenCalledOnce();
		expect(regularSetWheel).toHaveBeenCalledWith(4);
		renderer = fullscreen;
		rebindInteractiveTuiReference(tui);
		expect(fullscreenAddInput).toHaveBeenCalledTimes(2);
		expect(fullscreenAddRender).toHaveBeenCalledTimes(2);
		expect(fullscreenSetWheel).toHaveBeenCalledWith(4);

		stopInput();
		stopRender();
		expect(fullscreenAddInput.mock.results[1]?.value).toHaveBeenCalledOnce();
		expect(fullscreenAddRender.mock.results[1]?.value).toHaveBeenCalledOnce();
	});

	it("notifies observers with concrete renderers across regular and fullscreen modes", () => {
		const terminal = new VirtualTerminal(40, 8);
		const regular = new TuiMainScreen(terminal, false, "/tmp");
		let renderer: TUI = regular;
		const tui = createInteractiveTuiReference(() => renderer);
		const modes: string[] = [];
		const seen: TUI[] = [];
		const input = vi.fn();
		let attachCount = 0;
		let disposeCount = 0;
		let disposeActive = (): void => {};
		expect("onRendererChange" in tui).toBe(true);
		const stopObserving = tui.onRendererChange?.((current) => {
			modes.push(current.mode);
			seen.push(current);
			disposeActive();
			disposeActive = () => {};
			if (!isViewportTUI(current)) return;
			attachCount += 1;
			current.setWheelScrollLines(3);
			const unsubscribe = current.addViewportInputListener(input);
			let disposed = false;
			disposeActive = () => {
				if (disposed) return;
				disposed = true;
				disposeCount += 1;
				unsubscribe();
			};
		});
		try {
			expect(stopObserving).toBeTypeOf("function");
			if (!stopObserving) throw new Error("renderer observer subscription unavailable");
			rebindInteractiveTuiReference(tui);
			expect(modes).toEqual(["regular"]);
			const fullscreen = new TuiAltScreen(terminal, false, "/tmp");
			renderer = fullscreen;
			rebindInteractiveTuiReference(tui);
			fullscreen.start();
			terminal.sendInput("\x1b[<64;1;1M");
			expect(modes).toEqual(["regular", "fullscreen"]);
			expect(seen).toEqual([regular, fullscreen]);
			expect(attachCount).toBe(1);
			expect(Reflect.get(fullscreen, "wheelScrollLines")).toBe(3);
			expect(input).toHaveBeenCalledOnce();

			fullscreen.stop();
			const regularReplacement = new TuiMainScreen(terminal, false, "/tmp");
			renderer = regularReplacement;
			rebindInteractiveTuiReference(tui);
			expect(modes).toEqual(["regular", "fullscreen", "regular"]);
			expect(disposeCount).toBe(1);

			const fullscreenReplacement = new TuiAltScreen(terminal, false, "/tmp");
			renderer = fullscreenReplacement;
			rebindInteractiveTuiReference(tui);
			fullscreenReplacement.start();
			terminal.sendInput("\x1b[<64;1;1M");
			expect(modes).toEqual(["regular", "fullscreen", "regular", "fullscreen"]);
			expect(attachCount).toBe(2);
			expect(disposeCount).toBe(1);
			expect(Reflect.get(fullscreenReplacement, "wheelScrollLines")).toBe(3);
			expect(input).toHaveBeenCalledTimes(2);

			stopObserving();
			disposeActive();
			expect(disposeCount).toBe(2);
			fullscreenReplacement.stop();
		} finally {
			stopObserving?.();
			disposeActive();
		}
	});
});
