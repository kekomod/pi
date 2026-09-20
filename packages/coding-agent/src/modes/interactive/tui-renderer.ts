import type { Terminal } from "@earendil-works/pi-tui";
import {
	ProcessTerminal,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	type TuiRendererChangeListener,
} from "@earendil-works/pi-tui";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { keyDisplayText } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";

export interface InteractiveTuiOptions {
	readonly tuiMode: "regular" | "fullscreen";
	readonly showHardwareCursor: boolean;
	readonly logDirectory: string;
	readonly terminal?: Terminal;
	readonly onRightClickPaste?: () => void;
	readonly fullscreenCopyOnSelect?: boolean;
}

/** Composition root shared by coding-agent presentations. */
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "fullscreen" }): TuiAltScreen;
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "regular" }): TuiMainScreen;
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen;
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {
	const terminal = options.terminal ?? new ProcessTerminal();
	if (options.tuiMode === "fullscreen") {
		const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
		return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
			searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
			scrollToEndIndicator: () => {
				const shortcut = keyDisplayText("tui.altScreen.bottom");
				const label = ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `;
				return theme.bg("selectedBg", theme.fg("text", label));
			},
			openUrl: openBrowser,
			onRightClickPaste: options.onRightClickPaste,
			copyOnSelect: options.fullscreenCopyOnSelect,
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch {
					return false;
				}
			},
		});
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

type ViewportListenerProperty = "addViewportInputListener" | "addViewportRenderHook";

interface ViewportListenerRegistration {
	readonly property: ViewportListenerProperty;
	readonly args: readonly unknown[];
	boundTui: TUI;
	unsubscribe: () => void;
}

interface InteractiveTuiReferenceController {
	rebind(): void;
}

const interactiveTuiReferenceControllers = new WeakMap<TUI, InteractiveTuiReferenceController>();

function isViewportListenerProperty(property: string | symbol): property is ViewportListenerProperty {
	return property === "addViewportInputListener" || property === "addViewportRenderHook";
}

function asDisposer(value: unknown): () => void {
	return typeof value === "function" ? (value as () => void) : () => {};
}

/** Rebind viewport registrations after the active InteractiveMode renderer changes. */
export function rebindInteractiveTuiReference(reference: TUI): void {
	interactiveTuiReferenceControllers.get(reference)?.rebind();
}

/** Stable reference for components while InteractiveMode replaces the active renderer. */
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	const registrations = new Set<ViewportListenerRegistration>();
	const rendererListeners = new Set<TuiRendererChangeListener>();
	let wheelScrollLineArgs: readonly unknown[] | undefined;
	let lastNotifiedRenderer: TUI | undefined;
	const notifyRendererListeners = (renderer: TUI): void => {
		if (renderer === lastNotifiedRenderer) return;
		lastNotifiedRenderer = renderer;
		for (const listener of [...rendererListeners]) listener(renderer);
	};
	const controller: InteractiveTuiReferenceController = {
		rebind: () => {
			const currentTui = getTui();
			for (const registration of registrations) {
				if (registration.boundTui === currentTui) continue;
				registration.unsubscribe();
				const method = Reflect.get(currentTui, registration.property, currentTui);
				if (typeof method !== "function") {
					registration.boundTui = currentTui;
					registration.unsubscribe = () => {};
					continue;
				}
				const unsubscribe = Reflect.apply(method, currentTui, registration.args);
				registration.boundTui = currentTui;
				registration.unsubscribe = asDisposer(unsubscribe);
			}

			if (wheelScrollLineArgs !== undefined) {
				const setWheelScrollLines = Reflect.get(currentTui, "setWheelScrollLines", currentTui);
				if (typeof setWheelScrollLines === "function") {
					Reflect.apply(setWheelScrollLines, currentTui, wheelScrollLineArgs);
				}
			}

			notifyRendererListeners(currentTui);
		},
	};
	const reference = new Proxy({} as TUI, {
		get: (_target, property) => {
			if (property === "onRendererChange") {
				return (listener: TuiRendererChangeListener): (() => void) => {
					const currentTui = getTui();
					rendererListeners.add(listener);
					lastNotifiedRenderer = currentTui;
					try {
						listener(currentTui);
					} catch (error) {
						rendererListeners.delete(listener);
						throw error;
					}
					return () => rendererListeners.delete(listener);
				};
			}
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				const result = Reflect.apply(method, methodTui, args);
				if (isViewportListenerProperty(property) && typeof result === "function") {
					const registration: ViewportListenerRegistration = {
						property,
						args,
						boundTui: methodTui,
						unsubscribe: asDisposer(result),
					};
					registrations.add(registration);
					return () => {
						if (!registrations.delete(registration)) return;
						registration.unsubscribe();
					};
				}
				if (property === "setWheelScrollLines") wheelScrollLineArgs = args;
				return result;
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => property === "onRendererChange" || Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
	interactiveTuiReferenceControllers.set(reference, controller);
	return reference;
}
