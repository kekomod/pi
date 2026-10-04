import type { NestedToolCalls } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { ToolImagePresentation, ToolPresentationFactory } from "../src/core/extensions/types.ts";
import { NESTED_CALL_LIMITS } from "../src/core/nested-tool-calls.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
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
			pendingTools: new Map(),
			chatContainer: { children: [builtin, dynamic] },
			session: {
				getToolDefinition: () => undefined,
				extensionRunner: { getToolPresentations: () => new Map() },
			},
			getToolExecutionComponents: prototype.getToolExecutionComponents,
			getRegisteredToolDefinition: prototype.getRegisteredToolDefinition,
		};

		prototype.setToolPresentation.call(fakeMode, "custom", factory);

		expect(seenNames).toEqual(["read", "mcp__docs__lookup"]);
		expect(sawBuiltinRenderer).toBe(true);
		expect(stripAnsi(builtin.render(80).join("\n"))).toContain("Custom read");
		expect(stripAnsi(dynamic.render(80).join("\n"))).toContain("Custom mcp__docs__lookup");
		expect(builtin.getGroupExpanded()).toBe(true);
	});

	test("applies declared factories before dynamic factories and reads the current runner after replacement", () => {
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
			session: {
				getToolDefinition: () => undefined,
				extensionRunner: { getToolPresentations: () => new Map([["shared", factory("declared")]]) },
			},
			getRegisteredToolDefinition: prototype.getRegisteredToolDefinition,
		};

		expect(readRenderer(mode)?.render(80).join("\n")).toContain("dynamic");
		mode.toolPresentationFactories.clear();
		mode.session.extensionRunner = {
			getToolPresentations: () => new Map([["shared", factory("replacement")]]),
		};
		expect(readRenderer(mode)?.render(80).join("\n")).toContain("replacement");
		mode.session.extensionRunner = { getToolPresentations: () => new Map() };
		expect(mode.getRegisteredToolDefinition("late_mcp_tool")).toBeUndefined();
	});

	test("uses wildcard image presentation as a fallback with exact-name precedence", () => {
		const wildcard: ToolImagePresentation = { spacingRows: 0 };
		const specific: ToolImagePresentation = { spacingRows: 2 };
		const named = { getToolName: () => "mcp__docs__lookup", setImagePresentation: vi.fn() };
		const other = { getToolName: () => "read", setImagePresentation: vi.fn() };
		const prototype = InteractiveMode.prototype as any;
		const fakeMode = {
			toolImagePresentations: new Map(),
			getToolExecutionComponents: () => new Set([named, other]),
			resolveToolImagePresentation: prototype.resolveToolImagePresentation,
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
