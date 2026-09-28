/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

function compactKeyPart(part: string): string {
	const key = part.toLowerCase();
	const symbol = (
		{
			up: "↑",
			down: "↓",
			left: "←",
			right: "→",
			shift: "⇧",
			return: "↵",
			enter: "↵",
			backspace: "⌫",
			delete: "⌦",
			escape: "⎋",
			tab: "⇥",
		} as Record<string, string>
	)[key];
	if (symbol) return symbol;
	if (process.platform === "darwin") {
		const macModifier = (
			{
				alt: "⌥",
				option: "⌥",
				ctrl: "⌃",
				control: "⌃",
				meta: "⌘",
				cmd: "⌘",
				command: "⌘",
			} as Record<string, string>
		)[key];
		if (macModifier) return macModifier;
	}
	return formatKeyPart(part, { capitalize: true });
}

/** Render a short key hint with platform-appropriate modifier symbols. */
export function compactKeyHint(key: string, description: string): string {
	const display = key
		.split("/")
		.map((chord) =>
			chord
				.split("+")
				.map(compactKeyPart)
				.join(process.platform === "darwin" ? "" : "+"),
		)
		.join("/");
	return theme.fg("dim", display) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
