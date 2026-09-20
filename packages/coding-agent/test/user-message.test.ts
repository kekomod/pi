import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});

	test("supports disposable row projections while preserving native rendering", () => {
		initTheme("dark");
		const component = new UserMessageComponent("hello");
		const dispose = component.addRenderProjection(({ nativeLines, role, width }) => {
			expect(role).toBe("user");
			expect(width).toBe(20);
			return nativeLines.map((line, index) => (index === 1 ? `${line} [projected]` : line));
		});

		expect(stripAnsi(component.render(20).join("\n"))).toContain("[projected]");
		dispose();
		expect(stripAnsi(component.render(20).join("\n"))).not.toContain("[projected]");
	});

	test("applies display text, native Markdown hooks, leading components, and width padding", () => {
		initTheme("dark");
		const component = new UserMessageComponent("stored message");
		component.setDisplayText(() => "display preview");
		component.setOutputPadding(({ width }) => (width < 40 ? 0 : 2));
		component.addLeadingComponent(() => new Text("leading component", 0, 0));
		component.addRegionPresentation(({ region }) =>
			region === "text"
				? {
						markdownOptions: {
							renderToken: ({ token, renderNative }) =>
								token.type === "paragraph" ? renderNative().map((line) => `${line} [native hook]`) : undefined,
						},
					}
				: undefined,
		);

		const rendered = stripAnsi(component.render(30).join("\n"));
		expect(rendered).toContain("leading component");
		expect(rendered).toContain("display preview [native hook]");
		expect(rendered).not.toContain("stored message");
		expect(rendered).toContain("display preview");
	});
});
