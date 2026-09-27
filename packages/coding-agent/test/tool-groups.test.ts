import { Container, MouseRegion, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type {
	ToolGroupMemberRenderContext,
	ToolGroupPresentation,
	ToolGroupRenderContext,
} from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent, type ToolRenderers } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupCoordinator } from "../src/modes/interactive/components/tool-groups.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
		hasOverlay: () => false,
	} as unknown as TUI;
}

interface RendererState {
	readonly calls: Map<string, Array<number | undefined>>;
	readonly bodyRenders: Map<string, number>;
	readonly groupContexts: Map<string, ToolGroupMemberRenderContext[]>;
	readonly headers: ToolGroupRenderContext[];
}

function createPresentation(state: RendererState): ToolGroupPresentation {
	return {
		groupKey: (name) => (name === "read" || name === "grep" ? "explored" : undefined),
		renderHeader: (context) => {
			state.headers.push(context);
			return new MouseRegion(
				new Text(
					`Explored ${context.size} pending=${context.pending} failed=${context.failed} elapsed=${context.elapsedMs ?? "unknown"}`,
					0,
					0,
				),
				(event) => {
					if (event.type !== "click") return undefined;
					context.setExpanded(!context.expanded);
					return { handled: true };
				},
			);
		},
	};
}

function createRenderers(id: string, state: RendererState): ToolRenderers {
	return {
		renderShell: "self",
		renderCall: (_args, _theme, context) => {
			const calls = state.calls.get(id) ?? [];
			calls.push(context.group?.index);
			state.calls.set(id, calls);
			if (context.group) {
				const contexts = state.groupContexts.get(id) ?? [];
				contexts.push(context.group);
				state.groupContexts.set(id, contexts);
			}
			state.bodyRenders.set(id, (state.bodyRenders.get(id) ?? 0) + 1);
			return new Text(`call ${id} group=${context.group?.index ?? "none"} expanded=${context.expanded}`, 0, 0);
		},
		renderResult: () => new Text(`result ${id}`, 0, 0),
	};
}

function createDynamicRenderers(state: RendererState): ToolRenderers {
	return {
		renderShell: "self",
		renderCall: (_args, _theme, context) => {
			const id = context.toolCallId;
			const calls = state.calls.get(id) ?? [];
			calls.push(context.group?.index);
			state.calls.set(id, calls);
			if (context.group) {
				const contexts = state.groupContexts.get(id) ?? [];
				contexts.push(context.group);
				state.groupContexts.set(id, contexts);
			}
			state.bodyRenders.set(id, (state.bodyRenders.get(id) ?? 0) + 1);
			return new Text(`call ${id} group=${context.group?.index ?? "none"}`, 0, 0);
		},
		renderResult: () => new Text("result", 0, 0),
	};
}

function createComponent(
	id: string,
	state: RendererState,
	coordinator?: ToolGroupCoordinator,
	name = "read",
): ToolExecutionComponent {
	return new ToolExecutionComponent(
		name,
		id,
		{ path: `${id}.ts` },
		{ groupCoordinator: coordinator },
		createRenderers(id, state),
		createFakeTui(),
		process.cwd(),
	);
}

function createState(): RendererState {
	return { calls: new Map(), bodyRenders: new Map(), groupContexts: new Map(), headers: [] };
}

function assistant(content: unknown[] = []): Record<string, unknown> {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolCall(id: string): Record<string, unknown> {
	return { type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } };
}

function groupIndex(state: RendererState, id: string): number | undefined {
	return state.calls.get(id)?.at(-1);
}

describe("native transcript tool groups", () => {
	test("renders one header, removes follower spacing, and updates aggregate state without rerendering the first body", () => {
		initTheme("dark");
		const state = createState();
		const coordinator = new ToolGroupCoordinator(createPresentation(state));
		const first = createComponent("first", state, coordinator);
		const firstGroupContext = state.groupContexts.get("first")?.at(-1);
		expect(firstGroupContext).toMatchObject({ index: 0, size: 1 });
		const firstBodyRenderCountAfterCreation = state.bodyRenders.get("first");
		const second = createComponent("second", state, coordinator, "grep");
		expect(firstGroupContext).toMatchObject({ index: 0, size: 2 });
		expect(state.bodyRenders.get("first")).toBe(firstBodyRenderCountAfterCreation);
		const transcript = new Container();
		transcript.addChild(first);
		transcript.addChild(second);

		const rows = transcript.render(100).map(stripAnsi);
		expect(rows[0]).toBe("");
		expect(rows[1]).toContain("Explored 2 pending=2 failed=0");
		expect(rows[2]).toContain("call first group=0");
		expect(rows[3]).toContain("call second group=1");
		const firstBodyRenderCount = state.bodyRenders.get("first");
		expect(firstGroupContext).toMatchObject({ index: 0, size: 2 });

		first.setExpanded(true);
		const countAfterFirstExpansion = state.bodyRenders.get("first");
		second.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
		expect(state.headers.at(-1)).toMatchObject({ size: 2, pending: 1, failed: 0 });
		expect(state.bodyRenders.get("first")).toBe(countAfterFirstExpansion);
		expect(countAfterFirstExpansion).toBeGreaterThan(firstBodyRenderCount ?? 0);

		const headerRow = first.render(100).findIndex((row) => stripAnsi(row).includes("Explored"));
		const click: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 1,
			y: headerRow,
			screenX: 1,
			screenY: headerRow,
			width: 100,
			height: first.render(100).length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(first.handleMouse(click)?.handled).toBe(true);
		expect(state.calls.get("first")?.at(-1)).toBe(0);
		expect(state.calls.get("second")?.at(-1)).toBe(1);
		expect(state.headers.at(-1)?.expanded).toBe(true);
	});

	test("reindexes a detached first member and clears membership when the replacement excludes the tool", () => {
		initTheme("dark");
		const state = createState();
		const coordinator = new ToolGroupCoordinator(createPresentation(state));
		const first = createComponent("first", state, coordinator);
		const second = createComponent("second", state, coordinator);

		first.setToolGroupCoordinator(undefined);
		expect(groupIndex(state, "second")).toBe(0);
		expect(state.groupContexts.get("second")?.at(-1)).toMatchObject({ index: 0, size: 1 });
		const noGroups: ToolGroupPresentation = {
			groupKey: () => undefined,
			renderHeader: () => new Text("unexpected", 0, 0),
		};
		coordinator.setPresentation(noGroups);
		second.setToolGroupCoordinator(coordinator);
		expect(groupIndex(state, "second")).toBeUndefined();
		expect(stripAnsi(second.render(100).join("\n"))).not.toContain("Explored");
	});

	test("measures the whole group interval for sequential and overlapping executions, including failures", () => {
		initTheme("dark");
		const sequentialState = createState();
		const sequentialCoordinator = new ToolGroupCoordinator(createPresentation(sequentialState));
		const first = createComponent("sequential-first", sequentialState, sequentialCoordinator);
		const second = createComponent("sequential-second", sequentialState, sequentialCoordinator, "grep");
		first.markExecutionStarted(100);
		first.updateResult({ content: [], isError: false }, false, 120);
		second.markExecutionStarted(125);
		second.updateResult({ content: [], isError: false }, false, 150);
		expect(sequentialState.headers.at(-1)?.elapsedMs).toBe(50);

		const overlappingState = createState();
		const overlappingCoordinator = new ToolGroupCoordinator(createPresentation(overlappingState));
		const overlappingFirst = createComponent("overlap-first", overlappingState, overlappingCoordinator);
		const overlappingFailure = createComponent("overlap-failure", overlappingState, overlappingCoordinator, "grep");
		overlappingFirst.markExecutionStarted(10);
		overlappingFirst.updateResult({ content: [], isError: false }, false, 60);
		overlappingFailure.markExecutionStarted(30);
		overlappingFailure.updateResult({ content: [], isError: true }, false, 70);
		expect(overlappingState.headers.at(-1)).toMatchObject({ elapsedMs: 60, failed: 1, pending: 0 });
	});

	test("leaves replay timing absent when execution endpoints were not persisted", () => {
		initTheme("dark");
		const state = createState();
		const coordinator = new ToolGroupCoordinator(createPresentation(state));
		const first = createComponent("replay-first", state, coordinator);
		const second = createComponent("replay-second", state, coordinator, "grep");
		first.updateResult({ content: [], isError: false });
		second.updateResult({ content: [], isError: false });
		expect(state.headers.at(-1)?.elapsedMs).toBeUndefined();
	});

	test("a new group after its last member detaches is retired by reset", () => {
		initTheme("dark");
		const state = createState();
		const coordinator = new ToolGroupCoordinator(createPresentation(state));
		const oldMember = createComponent("old", state, coordinator);
		oldMember.setToolGroupCoordinator(undefined);
		const newMember = createComponent("new", state, coordinator);

		coordinator.reset();
		expect(state.calls.get("new")?.at(-1)).toBeUndefined();
		expect(stripAnsi(newMember.render(100).join("\n"))).not.toContain("Explored");
	});

	test("reconfigures flat replay siblings across tool-only and visible assistant messages", () => {
		initTheme("dark");
		const state = createState();
		const chatContainer = new Container();
		const first = createComponent("first", state);
		const afterToolOnly = createComponent("after-tool-only", state);
		const afterAborted = createComponent("after-aborted", state);
		const afterErrored = createComponent("after-errored", state);
		const truncatedCall = createComponent("truncated-call", state);
		const afterTruncated = createComponent("after-truncated", state);
		const afterVisible = createComponent("after-visible", state);
		chatContainer.addChild(first);
		chatContainer.addChild(new AssistantMessageComponent(assistant([toolCall("hidden-call")] as never) as never));
		chatContainer.addChild(afterToolOnly);
		const aborted = assistant();
		aborted.stopReason = "aborted";
		chatContainer.addChild(new AssistantMessageComponent(aborted as never));
		chatContainer.addChild(afterAborted);
		const errored = assistant();
		errored.stopReason = "error";
		chatContainer.addChild(new AssistantMessageComponent(errored as never));
		chatContainer.addChild(afterErrored);
		const truncated = assistant([toolCall("truncated-call")]);
		truncated.stopReason = "length";
		chatContainer.addChild(new AssistantMessageComponent(truncated as never));
		chatContainer.addChild(truncatedCall);
		chatContainer.addChild(afterTruncated);
		chatContainer.addChild(new AssistantMessageComponent(assistant([{ type: "text", text: "visible" }]) as never));
		chatContainer.addChild(afterVisible);
		const coordinator = new ToolGroupCoordinator(createPresentation(state));
		const fixture = { toolGroupCoordinator: coordinator, chatContainer, isInitialized: true };
		const rebuild = Reflect.get(InteractiveMode.prototype, "rebuildToolGroupMemberships") as (
			this: typeof fixture,
		) => void;

		rebuild.call(fixture);
		expect(groupIndex(state, "first")).toBe(0);
		expect(groupIndex(state, "after-tool-only")).toBe(1);
		expect(groupIndex(state, "after-aborted")).toBe(0);
		expect(groupIndex(state, "after-errored")).toBe(0);
		expect(groupIndex(state, "truncated-call")).toBe(0);
		expect(groupIndex(state, "after-truncated")).toBe(1);
		expect(groupIndex(state, "after-visible")).toBe(0);
	});

	test("a tool-only streaming assistant keeps the group, then visible content moves its calls behind a boundary", async () => {
		initTheme("dark");
		const state = createState();
		const coordinator = new ToolGroupCoordinator(createPresentation(state));
		const previous = createComponent("previous", state, coordinator);
		const chatContainer = new Container();
		chatContainer.addChild(previous);
		const applyBoundary = Reflect.get(InteractiveMode.prototype, "applyStreamingToolGroupBoundary") as (
			this: typeof fixture,
			message: never,
		) => void;
		const fixture = {
			isInitialized: true,
			footer: { invalidate: () => {} },
			toolGroupCoordinator: coordinator,
			streamingAssistantVisible: false,
			streamingComponent: undefined as AssistantMessageComponent | undefined,
			streamingMessage: undefined as unknown,
			chatContainer,
			pendingTools: new Map<string, ToolExecutionComponent>(),
			ui: createFakeTui(),
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 0,
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers: () => [],
			attachMessagePresentations: () => {},
			getRegisteredToolDefinition: () => createDynamicRenderers(state),
			settingsManager: {
				getShowImages: () => false,
				getImageWidthCells: () => 60,
			},
			sessionManager: { getCwd: () => process.cwd() },
			toolImagePresentations: new Map(),
			toolOutputExpanded: false,
			applyStreamingToolGroupBoundary(message: never) {
				applyBoundary.call(fixture, message);
			},
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fixture,
			event: never,
		) => Promise<void>;
		await handleEvent.call(fixture, { type: "message_start", message: assistant() } as never);
		await handleEvent.call(fixture, { type: "message_update", message: assistant([toolCall("one")]) } as never);
		expect(groupIndex(state, "one")).toBe(1);
		await handleEvent.call(fixture, {
			type: "message_update",
			message: assistant([toolCall("one"), { type: "text", text: "visible" }, toolCall("two")]),
		} as never);
		expect(groupIndex(state, "previous")).toBe(0);
		expect(groupIndex(state, "one")).toBe(0);
		expect(groupIndex(state, "two")).toBe(1);
		await handleEvent.call(fixture, {
			type: "tool_execution_start",
			toolCallId: "one",
			toolName: "read",
			args: {},
		} as never);
		await handleEvent.call(fixture, {
			type: "tool_execution_start",
			toolCallId: "two",
			toolName: "read",
			args: {},
		} as never);
		await handleEvent.call(fixture, {
			type: "tool_execution_end",
			toolCallId: "one",
			toolName: "read",
			result: { content: [{ type: "text", text: "one" }] },
			isError: false,
		} as never);
		await handleEvent.call(fixture, {
			type: "tool_execution_end",
			toolCallId: "two",
			toolName: "read",
			result: { content: [{ type: "text", text: "two" }] },
			isError: false,
		} as never);
		expect(state.headers.at(-1)).toMatchObject({ pending: 0 });
		expect(state.headers.at(-1)?.elapsedMs).toBeGreaterThanOrEqual(0);
	});
});
