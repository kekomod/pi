import type { TUI, ViewportTUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
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
});
