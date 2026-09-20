import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	getMarkdownTheme,
	InteractiveMode,
	initTheme,
	type QueuedMessagePresentationFactory,
	UserMessageComponent,
} from "../src/index.ts";

interface QueueFixture {
	pendingMessagesContainer: Container;
	getAllQueuedMessages: () => { steering: string[]; followUp: string[] };
	getAppKeyDisplay: (key: string) => string;
	getMarkdownThemeWithSettings: () => ReturnType<typeof getMarkdownTheme>;
	getMarkdownTransformers: () => [];
	outputPad: number;
	queuedMessagePresentation: QueuedMessagePresentationFactory | undefined;
}

const updatePendingMessagesDisplay = Reflect.get(InteractiveMode.prototype, "updatePendingMessagesDisplay") as (
	this: QueueFixture,
) => void;

describe("queued message presentation", () => {
	test("literal user components retain panels while preserving source text", () => {
		initTheme("dark", false);
		const source = "# Heading\n\nKeep **Markdown** literal\n\x1b]0;unsafe\x07";
		const component = new UserMessageComponent(source, getMarkdownTheme(), 1, [], { literal: true });
		const rows = component.render(80);
		const text = stripTerminalSequences(rows.join("\n"));

		expect(text).toContain("# Heading");
		expect(text).toContain("**Markdown**");
		expect(text).toContain("\\x1b]0;unsafe\\x07");
		expect(rows.join("\n")).not.toContain("\x1b]0;unsafe\x07");
	});

	test("custom components replace only queued rows and preserve the native edit hint", () => {
		initTheme("dark", false);
		const steering = ["Steer one", "Steer two"];
		const followUp = ["Follow one"];
		const seen: Array<{ kind: "steering" | "followUp"; text: string }> = [];
		const fixture: QueueFixture = {
			pendingMessagesContainer: new Container(),
			getAllQueuedMessages: () => ({ steering: [...steering], followUp: [...followUp] }),
			getAppKeyDisplay: (key) => {
				expect(key).toBe("app.message.dequeue");
				return "alt+shift+up";
			},
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers: () => [],
			outputPad: 1,
			queuedMessagePresentation: (context) => {
				seen.push({ kind: context.kind, text: context.text });
				return context.createUserMessage({ literal: true });
			},
		};

		updatePendingMessagesDisplay.call(fixture);
		const output = stripTerminalSequences(fixture.pendingMessagesContainer.render(80).join("\n"));

		expect(seen).toEqual([
			{ kind: "steering", text: "Steer one" },
			{ kind: "steering", text: "Steer two" },
			{ kind: "followUp", text: "Follow one" },
		]);
		expect(output).toContain("Steer one");
		expect(output).toContain("Follow one");
		expect(output).not.toContain("Steering: ");
		expect(output).not.toContain("Follow-up: ");
		expect(output).toContain("alt+shift+up to edit all queued messages");
		expect(steering).toEqual(["Steer one", "Steer two"]);
		expect(followUp).toEqual(["Follow one"]);
	});

	test("native rows remain the fallback when a presentation is absent or fails", () => {
		initTheme("dark", false);
		const base: Omit<QueueFixture, "queuedMessagePresentation"> = {
			pendingMessagesContainer: new Container(),
			getAllQueuedMessages: () => ({ steering: ["native"], followUp: [] }),
			getAppKeyDisplay: () => "alt+shift+up",
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers: () => [],
			outputPad: 1,
		};
		const fixture: QueueFixture = { ...base, queuedMessagePresentation: undefined };
		updatePendingMessagesDisplay.call(fixture);
		expect(stripTerminalSequences(fixture.pendingMessagesContainer.render(80).join("\n"))).toContain(
			"Steering: native",
		);

		fixture.pendingMessagesContainer.clear();
		fixture.queuedMessagePresentation = () => {
			throw new Error("presentation failure");
		};
		updatePendingMessagesDisplay.call(fixture);
		expect(stripTerminalSequences(fixture.pendingMessagesContainer.render(80).join("\n"))).toContain(
			"Steering: native",
		);
	});
});
