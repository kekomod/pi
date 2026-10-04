import type { NestedToolCalls } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type {
	ToolGroupPresentation,
	ToolImagePresentation,
	ToolPresentationFactory,
} from "../src/core/extensions/types.ts";
import { NESTED_CALL_LIMITS } from "../src/core/nested-tool-calls.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupCoordinator } from "../src/modes/interactive/components/tool-groups.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui() {
	return { requestRender: vi.fn(), hasOverlay: () => false } as any;
}

describe("InteractiveMode tool presentation", () => {
	test("applies keyed factories to native and unresolved dynamic tool rows and rebinds retained rows", () => {
		initTheme("dark");
		const tui = createFakeTui();
		const builtin = new ToolExecutionComponent("read", "read-1", {}, {}, undefined, tui, process.cwd());
		const dynamic = new ToolExecutionComponent("mcp__docs__lookup", "mcp-1", {}, {}, undefined, tui, process.cwd());
		builtin.setExpanded(true);
		const seenNames: string[] = [];
		let sawBuiltinRenderer = false;
		const factory: ToolPresentationFactory = (target) => {
			seenNames.push(target.name);
			if (target.name === "read") sawBuiltinRenderer = target.renderers.renderCall !== undefined;
			if (!target.name.startsWith("mcp__") && target.name !== "read") return undefined;
			return {
				renderShell: "self",
				renderCall: () => new Text(`Custom ${target.name}`, 0, 0),
			};
		};
		const prototype = InteractiveMode.prototype as any;
		const fakeMode = {
			toolPresentationFactories: new Map(),
			interactivePresentationSetupDepth: 0,
			pendingTools: new Map(),
			chatContainer: { children: [builtin, dynamic] },
			session: {
				getToolDefinition: () => undefined,
				extensionRunner: {},
			},
			getToolExecutionComponents: prototype.getToolExecutionComponents,
			getRegisteredToolDefinition: prototype.getRegisteredToolDefinition,
			isExtensionSessionShuttingDown: prototype.isExtensionSessionShuttingDown,
			shouldRefreshInteractivePresentations: prototype.shouldRefreshInteractivePresentations,
		};

		prototype.setToolPresentation.call(fakeMode, "custom", factory);

		expect(seenNames).toEqual(["read", "mcp__docs__lookup"]);
		expect(sawBuiltinRenderer).toBe(true);
		expect(stripAnsi(builtin.render(80).join("\n"))).toContain("Custom read");
		expect(stripAnsi(dynamic.render(80).join("\n"))).toContain("Custom mcp__docs__lookup");
		expect(builtin.getGroupExpanded()).toBe(true);
	});

	test("applies dynamic factories to the current renderer definition", () => {
		const prototype = InteractiveMode.prototype as any;
		const factory =
			(label: string): ToolPresentationFactory =>
			() => ({
				renderCall: () => new Text(label, 0, 0),
			});
		const readRenderer = (mode: any) =>
			mode.getRegisteredToolDefinition("late_mcp_tool")?.renderCall?.({}, initTheme("dark"), {});
		const mode = {
			toolPresentationFactories: new Map([["shared", factory("dynamic")]]),
			session: { getToolDefinition: () => undefined },
			getRegisteredToolDefinition: prototype.getRegisteredToolDefinition,
		};

		expect(readRenderer(mode)?.render(80).join("\n")).toContain("dynamic");
		mode.toolPresentationFactories.clear();
		expect(mode.getRegisteredToolDefinition("late_mcp_tool")).toBeUndefined();
	});

	test("batches all presentation setters before the replay render and keeps theme live", () => {
		const prototype = InteractiveMode.prototype as any;
		const rebuildChatFromMessages = vi.fn();
		let currentTheme = { name: "first" };
		const session: { extensionRunner: any } = { extensionRunner: { isEmittingSessionShutdown: false } };
		const mode = {
			interactivePresentationRunner: undefined,
			interactivePresentationSetupDepth: 0,
			messagePresentationFactories: new Map(),
			messageEntryAssociations: new Map(),
			statusFilters: new Map(),
			toolImagePresentations: new Map(),
			toolPresentationFactories: new Map(),
			toolGroupCoordinator: { setPresentation: vi.fn() },
			pendingToolGroupPresentation: undefined,
			toolGroupPresentationPending: false,
			queuedMessagePresentation: undefined,
			defaultHiddenThinkingLabel: "Hidden thinking",
			hiddenThinkingLabel: "Hidden thinking",
			session,
			isInitialized: true,
			chatContainer: { children: [] },
			ui: { requestRender: vi.fn() },
			sessionManager: { getCwd: () => "/repo" },
			rebuildChatFromMessages,
			getToolExecutionComponents: () => new Set(),
			updatePendingMessagesDisplay: vi.fn(),
			setMessagePresentation: prototype.setMessagePresentation,
			setMessageEntryAssociation: prototype.setMessageEntryAssociation,
			setStatusFilter: prototype.setStatusFilter,
			setToolImagePresentation: prototype.setToolImagePresentation,
			setToolPresentation: prototype.setToolPresentation,
			setToolGroupPresentation: prototype.setToolGroupPresentation,
			setQueuedMessagePresentation: prototype.setQueuedMessagePresentation,
			setHiddenThinkingLabel: prototype.setHiddenThinkingLabel,
			isExtensionSessionShuttingDown: prototype.isExtensionSessionShuttingDown,
			shouldRefreshInteractivePresentations: prototype.shouldRefreshInteractivePresentations,
			createExtensionUIContext: () => ({
				setMessagePresentation: (key: string, factory: unknown) =>
					prototype.setMessagePresentation.call(mode, key, factory),
				setMessageEntryAssociation: (key: string, association: unknown) =>
					prototype.setMessageEntryAssociation.call(mode, key, association),
				setStatusFilter: (key: string, filter: unknown) => prototype.setStatusFilter.call(mode, key, filter),
				setToolImagePresentation: (key: string, presentation: unknown) =>
					prototype.setToolImagePresentation.call(mode, key, presentation),
				setToolPresentation: (key: string, factory: unknown) =>
					prototype.setToolPresentation.call(mode, key, factory),
				setToolGroupPresentation: (presentation: unknown) =>
					prototype.setToolGroupPresentation.call(mode, presentation),
				setQueuedMessagePresentation: (factory: unknown) =>
					prototype.setQueuedMessagePresentation.call(mode, factory),
				setHiddenThinkingLabel: (label: string) => prototype.setHiddenThinkingLabel.call(mode, label),
				get theme() {
					return currentTheme;
				},
			}),
			clearInteractivePresentationState: prototype.clearInteractivePresentationState,
			createInteractivePresentationContext: prototype.createInteractivePresentationContext,
			initializeInteractivePresentations: prototype.initializeInteractivePresentations,
		};
		const runner = {
			initializeInteractivePresentations(context: any) {
				context.ui.setMessagePresentation?.("messages", () => {});
				context.ui.setMessageEntryAssociation?.("custom", {});
				context.ui.setStatusFilter?.("status", () => true);
				context.ui.setToolImagePresentation?.("*", { spacingRows: 0 });
				context.ui.setToolPresentation?.("tools", () => undefined);
				context.ui.setToolGroupPresentation?.({} as ToolGroupPresentation);
				context.ui.setQueuedMessagePresentation?.(() => null);
				context.ui.setHiddenThinkingLabel?.("Thoughts");
			},
		};
		session.extensionRunner = runner;
		prototype.initializeInteractivePresentations.call(mode, runner);

		expect(mode.messagePresentationFactories.has("messages")).toBe(true);
		expect(mode.messageEntryAssociations.has("custom")).toBe(true);
		expect(mode.statusFilters.has("status")).toBe(true);
		expect(mode.toolImagePresentations.has("*")).toBe(true);
		expect(mode.toolPresentationFactories.has("tools")).toBe(true);
		expect(mode.toolGroupPresentationPending).toBe(true);
		expect(mode.queuedMessagePresentation).toEqual(expect.any(Function));
		expect(mode.hiddenThinkingLabel).toBe("Thoughts");
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		currentTheme = { name: "replacement" };
		expect(prototype.createInteractivePresentationContext.call(mode).ui.theme).toBe(currentTheme);
	});

	test("ignores shutdown group cleanup without detaching visible rows", () => {
		initTheme("dark");
		const originalPresentation: ToolGroupPresentation = {
			groupKey: () => "shell",
			renderHeader: () => new Text("Tools", 0, 0),
		};
		const coordinator = new ToolGroupCoordinator(originalPresentation);
		const tui = createFakeTui();
		const first = new ToolExecutionComponent(
			"bash",
			"bash-1",
			{},
			{ groupCoordinator: coordinator },
			undefined,
			tui,
			process.cwd(),
		);
		const second = new ToolExecutionComponent(
			"bash",
			"bash-2",
			{},
			{ groupCoordinator: coordinator },
			undefined,
			tui,
			process.cwd(),
		);
		first.render(80);
		second.render(80);
		expect(second.hasGroupLeadingSpacer()).toBe(false);

		const prototype = InteractiveMode.prototype as any;
		const mode = {
			interactivePresentationSetupDepth: 0,
			pendingToolGroupPresentation: undefined,
			toolGroupPresentationPending: false,
			toolGroupCoordinator: coordinator,
			session: { extensionRunner: { isEmittingSessionShutdown: true } },
			shouldRefreshInteractivePresentations: prototype.shouldRefreshInteractivePresentations,
			isExtensionSessionShuttingDown: prototype.isExtensionSessionShuttingDown,
			setToolGroupPresentation: prototype.setToolGroupPresentation,
		};
		prototype.setToolGroupPresentation.call(mode, undefined);

		expect(second.hasGroupLeadingSpacer()).toBe(false);
		expect(mode.toolGroupPresentationPending).toBe(false);
		expect(mode.pendingToolGroupPresentation).toBeUndefined();
	});

	test("uses wildcard image presentation as a fallback with exact-name precedence", () => {
		const wildcard: ToolImagePresentation = { spacingRows: 0 };
		const specific: ToolImagePresentation = { spacingRows: 2 };
		const named = { getToolName: () => "mcp__docs__lookup", setImagePresentation: vi.fn() };
		const other = { getToolName: () => "read", setImagePresentation: vi.fn() };
		const prototype = InteractiveMode.prototype as any;
		const fakeMode = {
			toolImagePresentations: new Map(),
			interactivePresentationSetupDepth: 0,
			session: { extensionRunner: { isEmittingSessionShutdown: false } },
			getToolExecutionComponents: () => new Set([named, other]),
			resolveToolImagePresentation: prototype.resolveToolImagePresentation,
			isExtensionSessionShuttingDown: prototype.isExtensionSessionShuttingDown,
			shouldRefreshInteractivePresentations: prototype.shouldRefreshInteractivePresentations,
		};

		prototype.setToolImagePresentation.call(fakeMode, "*", wildcard);
		expect(named.setImagePresentation).toHaveBeenLastCalledWith(wildcard);
		expect(other.setImagePresentation).toHaveBeenLastCalledWith(wildcard);

		prototype.setToolImagePresentation.call(fakeMode, "mcp__docs__lookup", specific);
		expect(named.setImagePresentation).toHaveBeenLastCalledWith(specific);
		expect(other.setImagePresentation).toHaveBeenLastCalledWith(wildcard);

		prototype.setToolImagePresentation.call(fakeMode, "mcp__docs__lookup", undefined);
		expect(named.setImagePresentation).toHaveBeenLastCalledWith(wildcard);
	});

	test("streams bounded structured nested-call records and replaces them with the native snapshot", () => {
		initTheme("dark");
		let visibleSnapshot: NestedToolCalls | undefined;
		const parent = new ToolExecutionComponent(
			"codemode",
			"parent-1",
			{},
			{},
			{
				renderCall: (_args, _theme, context) => {
					visibleSnapshot = context.nestedCalls;
					return new Text("script", 0, 0);
				},
			},
			createFakeTui(),
			process.cwd(),
		);
		const prototype = InteractiveMode.prototype as any;
		const fakeMode = {
			nestedToolCallRoots: new Map(),
			nestedCallRecorders: new Map(),
			nestedToolCallRecords: new Map(),
			nestedCallIdsByRoot: new Map(),
			pendingTools: new Map([["parent-1", parent]]),
			chatContainer: { children: [parent] },
			session: {
				getToolDefinition: (name: string) => (name === "read" ? { label: "Fixture · read [h7]" } : undefined),
			},
			resolveNestedToolRootId: prototype.resolveNestedToolRootId,
			updateNestedToolPresentation: prototype.updateNestedToolPresentation,
		};
		const structuredArgs = { path: "src/main.ts", limit: 20 };

		prototype.recordNestedToolCallStart.call(fakeMode, {
			toolCallId: "parent-1/1",
			toolName: "read",
			args: structuredArgs,
			parentToolCallId: "parent-1",
		});
		expect(visibleSnapshot?.calls[0]).toMatchObject({
			name: "read",
			label: "Fixture · read [h7]",
			arguments: structuredArgs,
			status: "unfinished",
		});
		expect(visibleSnapshot?.complete).toBe(false);

		let successfulTextReads = 0;
		prototype.recordNestedToolCallEnd.call(fakeMode, {
			toolCallId: "parent-1/1",
			toolName: "read",
			parentToolCallId: "parent-1",
			result: {
				content: [
					{
						type: "text",
						get text() {
							successfulTextReads++;
							return "private file contents";
						},
					},
				],
			},
			isError: false,
		});
		expect(successfulTextReads).toBe(0);
		expect(visibleSnapshot?.calls[0]?.status).toBe("ok");
		expect(JSON.stringify(visibleSnapshot)).not.toContain("private file contents");

		const errorText = "x".repeat(100_000);
		const errorBlocks = Array.from({ length: 10_000 }, (_, index) => ({
			type: "text",
			text: index === 63 ? errorText : "",
		}));
		let inspectedErrorBlocks = 0;
		const boundedErrorBlocks = new Proxy(errorBlocks, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/u.test(property)) {
					const index = Number(property);
					expect(index).toBeLessThan(NESTED_CALL_LIMITS.maxErrorBlocks);
					inspectedErrorBlocks++;
				}
				return Reflect.get(target, property, receiver);
			},
		});
		prototype.recordNestedToolCallStart.call(fakeMode, {
			toolCallId: "parent-1/2",
			toolName: "fetch_content",
			args: { url: "https://example.test/large-error" },
			parentToolCallId: "parent-1",
		});
		prototype.recordNestedToolCallEnd.call(fakeMode, {
			toolCallId: "parent-1/2",
			toolName: "fetch_content",
			parentToolCallId: "parent-1",
			result: { content: boundedErrorBlocks },
			isError: true,
		});
		expect(inspectedErrorBlocks).toBe(NESTED_CALL_LIMITS.maxErrorBlocks);
		expect(visibleSnapshot?.calls[1]?.status).toBe("error");
		expect(visibleSnapshot?.calls[1]?.error).toHaveLength(NESTED_CALL_LIMITS.maxErrorChars);
		expect(
			visibleSnapshot?.calls[1]?.error?.endsWith(
				"x".repeat(NESTED_CALL_LIMITS.maxErrorChars - NESTED_CALL_LIMITS.maxErrorBlocks + 1),
			),
		).toBe(true);

		const replayedSnapshot = { calls: visibleSnapshot?.calls ?? [], complete: true } satisfies NestedToolCalls;
		prototype.setFinalNestedToolPresentation.call(fakeMode, "parent-1", replayedSnapshot);
		expect(visibleSnapshot).toEqual(replayedSnapshot);
		expect(fakeMode.nestedCallRecorders.size).toBe(0);
	});

	test("bounds auxiliary live indexes and skips transcript lookup for ordinary tool results", () => {
		initTheme("dark");
		let visibleSnapshot: NestedToolCalls | undefined;
		const parent = new ToolExecutionComponent(
			"codemode",
			"parent-bounded",
			{},
			{},
			{
				renderCall: (_args, _theme, context) => {
					visibleSnapshot = context.nestedCalls;
					return new Text("script", 0, 0);
				},
			},
			createFakeTui(),
			process.cwd(),
		);
		const prototype = InteractiveMode.prototype as any;
		const fakeMode = {
			nestedToolCallRoots: new Map(),
			nestedCallRecorders: new Map(),
			nestedToolCallRecords: new Map(),
			nestedCallIdsByRoot: new Map(),
			pendingTools: new Map([["parent-bounded", parent]]),
			chatContainer: { children: [parent] },
			session: { getToolDefinition: () => undefined },
			resolveNestedToolRootId: prototype.resolveNestedToolRootId,
			updateNestedToolPresentation: prototype.updateNestedToolPresentation,
		};

		for (let index = 1; index <= 300; index++) {
			prototype.recordNestedToolCallStart.call(fakeMode, {
				toolCallId: `parent-bounded/${index}`,
				toolName: "read",
				args: { index },
				parentToolCallId: "parent-bounded",
			});
		}
		expect(visibleSnapshot?.calls).toHaveLength(256);
		expect(visibleSnapshot?.complete).toBe(false);
		expect(fakeMode.nestedToolCallRoots.size).toBe(256);
		expect(fakeMode.nestedToolCallRecords.size).toBe(256);
		expect(fakeMode.nestedCallIdsByRoot.get("parent-bounded").size).toBe(256);

		prototype.recordNestedToolCallStart.call(fakeMode, {
			toolCallId: "parent-bounded/300/1",
			toolName: "grep",
			args: { pattern: "needle" },
			parentToolCallId: "parent-bounded/300",
		});
		expect(fakeMode.nestedToolCallRoots.size).toBe(256);

		const finalSnapshot = fakeMode.nestedCallRecorders.get("parent-bounded").snapshot();
		prototype.setFinalNestedToolPresentation.call(fakeMode, "parent-bounded", finalSnapshot);
		expect(fakeMode.pendingTools.size).toBe(0);
		expect(fakeMode.nestedCallRecorders.size).toBe(0);
		expect(fakeMode.nestedToolCallRoots.size).toBe(0);
		expect(fakeMode.nestedToolCallRecords.size).toBe(0);
		expect(fakeMode.nestedCallIdsByRoot.size).toBe(0);

		const ordinaryMode = {
			nestedCallRecorders: new Map(),
			pendingTools: new Map(),
			get chatContainer(): never {
				throw new Error("ordinary tool rows must not scan transcript history");
			},
		};
		expect(() =>
			prototype.setFinalNestedToolPresentation.call(ordinaryMode, "ordinary-tool", undefined),
		).not.toThrow();
	});
});
