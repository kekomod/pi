import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionController } from "../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("live session controller", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("accepts remote prompts before the run finishes and sends them through the TUI session stream", async () => {
		const toolStarted = deferred();
		const releaseTool = deferred();
		const tool: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Wait until the test releases the tool",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		let extensionApi: ExtensionAPI | undefined;
		const inputSources: string[] = [];
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("input", (event) => {
						inputSources.push(event.source);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("complete"),
		]);
		const controller = extensionApi?.getSessionController?.();
		expect(controller).toBeDefined();

		const tuiUserMessages: string[] = [];
		const unsubscribeTui = harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				tuiUserMessages.push(getMessageText(event.message));
			}
		});
		const submitted = controller!.prompt([
			{ type: "text", text: "describe this" },
			{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
		]);
		await toolStarted.promise;

		expect(await submitted).toEqual({ accepted: true });
		expect(harness.session.isStreaming).toBe(true);
		expect(tuiUserMessages).toEqual(["describe this"]);
		expect(inputSources).toEqual(["remote"]);
		expect(harness.session.messages[0]?.role).toBe("user");
		if (harness.session.messages[0]?.role === "user") {
			const content = harness.session.messages[0].content;
			if (Array.isArray(content)) {
				expect(content).toContainEqual({
					type: "image",
					mimeType: "image/png",
					data: "ZmFrZQ==",
				});
			}
		}

		releaseTool.resolve();
		await harness.session.waitForIdle();
		unsubscribeTui();
	});

	it("publishes detached, bounded snapshots without request configuration", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");

		const snapshot = extensionApi?.getSessionController?.().getSnapshot();
		expect(snapshot?.sessionId).toBe(harness.session.sessionId);
		expect(snapshot?.entries).toHaveLength(2);
		expect(snapshot?.model).toMatchObject({ provider: harness.getModel().provider, id: harness.getModel().id });
		expect(snapshot?.model).not.toHaveProperty("baseUrl");
		expect(snapshot?.model).not.toHaveProperty("headers");
		if (snapshot?.entries[0]?.type === "message" && snapshot.entries[0].message.role === "user") {
			const content = snapshot.entries[0].message.content;
			if (Array.isArray(content)) {
				const textPart = content[0];
				if (textPart?.type === "text") textPart.text = "mutated snapshot";
			}
		}
		expect(getMessageText(harness.session.messages[0])).toBe("hi");
		expect(extensionApi?.getSessionController?.().getSnapshot({ entryLimit: 1 }).entries).toHaveLength(1);
		expect(extensionApi?.getSessionController?.().getSnapshot({ entryLimit: 0 }).entries).toEqual([]);

		for (let index = 0; index < 205; index++) {
			harness.session.sessionManager.appendCustomMessageEntry("synthetic", `entry ${index}`, true);
		}
		expect(extensionApi?.getSessionController?.().getSnapshot().entries).toHaveLength(200);
	});

	it("reports preflight rejection once with a bounded reason and streams accepted-turn errors", async () => {
		const rejectedHarness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(rejectedHarness);
		const rejected = await rejectedHarness.session.getSessionController().prompt("no credentials");
		expect(rejected.accepted).toBe(false);
		if (!rejected.accepted) {
			expect(rejected.reason).toContain("No API key");
			expect(rejected.reason.length).toBeLessThanOrEqual(256);
		}
		expect(rejectedHarness.session.messages).toEqual([]);

		const failedHarness = await createHarness();
		harnesses.push(failedHarness);
		failedHarness.setResponses([
			fauxAssistantMessage("synthetic failure", {
				stopReason: "error",
				errorMessage: "synthetic late failure",
			}),
		]);
		const controller = failedHarness.session.getSessionController();
		expect(await controller.prompt("accepted first")).toEqual({ accepted: true });
		await failedHarness.session.waitForIdle();
		expect(
			failedHarness.events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.stopReason === "error",
			),
		).toBe(true);
	});

	it("streams queue changes, clears the native queues, and aborts the shared run", async () => {
		const toolStarted = deferred();
		const releaseTool = deferred();
		const tool: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Wait until the test releases the tool",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" })]);
		const controller = harness.session.getSessionController();
		const events: string[][] = [];
		const unsubscribe = controller.subscribe((event) => {
			if (event.type === "queue_update") events.push([...event.followUp]);
		});
		const firstPrompt = controller.prompt("start");
		await toolStarted.promise;
		expect(await firstPrompt).toEqual({ accepted: true });
		expect(await controller.prompt("later", { deliverAs: "followUp" })).toEqual({ accepted: true });
		expect(controller.getSnapshot().queue.followUp).toEqual(["later"]);
		expect(controller.clearQueue()).toEqual({ steering: [], followUp: ["later"] });
		expect(controller.getSnapshot().queue.followUp).toEqual([]);
		expect(events).toEqual([["later"], []]);

		const aborting = controller.abort();
		releaseTool.resolve();
		await aborting;
		expect(harness.session.isIdle).toBe(true);
		unsubscribe();
	});

	it("invalidates captured controllers and removes their subscriptions on reload", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		harnesses.push(harness);
		const oldController: SessionController | undefined = extensionApi?.getSessionController?.();
		expect(oldController).toBeDefined();
		let oldEventCount = 0;
		oldController?.subscribe(() => oldEventCount++);

		await harness.session.reload();
		harness.session.setSessionName("after reload");
		expect(oldEventCount).toBe(0);
		expect(() => oldController?.getSnapshot()).toThrow(/stale/i);

		const endingController = harness.session.getSessionController();
		harness.session.dispose();
		expect(() => endingController.getSnapshot()).toThrow(/stale/i);
	});

	it("invalidates direct controllers and detaches listeners when the active tree branch changes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first question");
		await harness.session.waitForIdle();
		await harness.session.prompt("second question");
		await harness.session.waitForIdle();

		const firstUserEntry = harness.session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(firstUserEntry).toBeDefined();
		const controller = harness.session.getSessionController();
		let eventCount = 0;
		controller.subscribe(() => eventCount++);

		await harness.session.navigateTree(firstUserEntry!.id);
		harness.session.setSessionName("new branch context");
		expect(eventCount).toBe(0);
		expect(() => controller.getSnapshot()).toThrow(/stale/i);
		expect(() => controller.clearQueue()).toThrow(/stale/i);
		expect(harness.session.getSessionController().getSnapshot().sessionId).toBe(harness.session.sessionId);
	});
});
