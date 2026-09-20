import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import type { SelectList } from "../src/components/select-list.ts";
import type { TUI, TuiMouseEvent, TuiMouseEventType } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

const editorTheme = {
	borderColor: (text: string): string => text,
	selectList: {
		selectedPrefix: (text: string): string => text,
		selectedText: (text: string): string => text,
		description: (text: string): string => text,
		scrollInfo: (text: string): string => text,
		noMatch: (text: string): string => text,
	},
};

const items = [
	{ value: "/first", label: "/first" },
	{ value: "/second", label: "/second" },
	{ value: "/third", label: "/third" },
];

function createTui(): TUI {
	return {
		terminal: { rows: 24 } as TUI["terminal"],
		requestRender: () => {},
	} as unknown as TUI;
}

function mouse(type: TuiMouseEventType, y: number): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width: 80,
		height: 20,
		shift: false,
		alt: false,
		ctrl: false,
		...(type === "click" ? { clickCount: 1 } : {}),
	};
}

function applyCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: { value: string },
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[cursorLine] ?? "";
	const nextLines = [...lines];
	nextLines[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
	return {
		lines: nextLines,
		cursorLine,
		cursorCol: cursorCol - prefix.length + item.value.length,
	};
}

function provider(): AutocompleteProvider {
	return {
		getSuggestions: async (lines, cursorLine, cursorCol) => ({
			items,
			prefix: (lines[cursorLine] ?? "").slice(0, cursorCol),
		}),
		applyCompletion,
	};
}

async function showAutocomplete(editor: Editor): Promise<void> {
	editor.setAutocompleteProvider(provider());
	editor.handleInput("/");
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

class DelegatingEditor extends Editor {
	protected override renderAutocompleteList(list: SelectList, width: number, prefix: string): string[] {
		return super.renderAutocompleteList(list, width, prefix);
	}
}

class FixedSlashRowsEditor extends Editor {
	protected override renderAutocompleteList(list: SelectList, width: number, prefix: string): string[] {
		const rows = super.renderAutocompleteList(list, width, prefix);
		if (!prefix.startsWith("/")) return rows;
		return [...rows.slice(0, 5), ...Array(Math.max(0, 5 - rows.length)).fill("")];
	}
}

function listRows(editor: Editor, width: number): string[] {
	return editor.render(width).slice(3);
}

describe("Editor autocomplete render hook", () => {
	it("keeps default rendering byte-for-byte compatible", async () => {
		const native = new Editor(createTui(), editorTheme, { autocompleteMaxVisible: 20 });
		const delegated = new DelegatingEditor(createTui(), editorTheme, { autocompleteMaxVisible: 20 });

		await showAutocomplete(native);
		await showAutocomplete(delegated);

		assert.deepStrictEqual(delegated.render(80), native.render(80));
		assert.deepStrictEqual(listRows(delegated, 80), native.render(80).slice(3));
	});

	it("allows slash rows to be bounded and padded without replacing the native list", async () => {
		const editor = new FixedSlashRowsEditor(createTui(), editorTheme, { autocompleteMaxVisible: 20 });

		await showAutocomplete(editor);
		const rows = listRows(editor, 80);

		assert.equal(rows.length, 5);
		assert.ok(rows.every((row) => visibleWidth(row) <= 80));
		assert.match(rows[0] ?? "", /first/);
		assert.match(rows[2] ?? "", /third/);
	});

	it("pads a short slash list while leaving non-slash prefixes unchanged", async () => {
		const editor = new FixedSlashRowsEditor(createTui(), editorTheme, { autocompleteMaxVisible: 20 });
		await showAutocomplete(editor);
		const slashRows = listRows(editor, 80);
		assert.equal(slashRows.length, 5);

		const plainRows = new FixedSlashRowsEditor(createTui(), editorTheme, { autocompleteMaxVisible: 20 });
		plainRows.setAutocompleteProvider({
			...provider(),
			getSuggestions: async () => ({ items: [{ value: "@plain-one", label: "@plain-one" }], prefix: "@" }),
		});
		plainRows.handleInput("@");
		await new Promise((resolve) => setTimeout(resolve, 30));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(listRows(plainRows, 80).length, 1);
	});

	it("keeps native keyboard selection and completion callbacks", async () => {
		const editor = new FixedSlashRowsEditor(createTui(), editorTheme);
		await showAutocomplete(editor);

		editor.handleInput("\x1b[B");
		editor.handleInput("\t");

		assert.equal(editor.getText(), "/second");
		assert.equal(editor.isShowingAutocomplete(), false);
	});

	it("keeps native mouse selection and completion callbacks", async () => {
		const editor = new FixedSlashRowsEditor(createTui(), editorTheme);
		await showAutocomplete(editor);
		editor.render(80);

		assert.equal(editor.handleMouse?.(mouse("press", 4))?.handled, true);
		assert.equal(editor.handleMouse?.(mouse("click", 4))?.handled, true);
		assert.equal(editor.getText(), "/second");
	});
});
