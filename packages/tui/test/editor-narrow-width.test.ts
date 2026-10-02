import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wordWrapLine } from "../src/components/editor.ts";

describe("narrow Unicode editor layout", () => {
	it("keeps progress when a grapheme is wider than the available width", () => {
		const text = "日本語 🙂";
		const chunks = wordWrapLine(text, 1);

		assert.ok(chunks.length > 0);
		assert.equal(chunks.map((chunk) => text.slice(chunk.startIndex, chunk.endIndex)).join(""), text);
	});
});
