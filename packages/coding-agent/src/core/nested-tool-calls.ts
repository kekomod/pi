/**
 * Tool calls that a tool makes while it runs (`ctx.executeTool()`), for example from codemode
 * scripts. The agent loop does not know about them: the session runs each one through the agent's
 * tool pipeline (`runToolCall`) with its own hooks, emits `tool_execution_*` events with
 * `parentToolCallId`, and records the calls and their usage on the model-issued call's tool result
 * message.
 *
 * Nothing here runs until a tool calls `ctx.executeTool()`.
 */

import type {
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { JsonObject, NestedToolCallRecord, NestedToolCalls, Usage } from "@earendil-works/pi-ai";
import { combineUsage } from "./usage-totals.ts";

/**
 * Limits of the nested-call record on a tool result: arguments
 * over the per-call or total size are omitted, calls beyond the count are dropped, and the record
 * is marked incomplete when any of that happens.
 */
export const NESTED_CALL_LIMITS = {
	maxCalls: 256,
	maxArgumentBytesPerCall: 8 * 1024,
	maxArgumentBytesTotal: 32 * 1024,
	maxArgumentPreflightNodes: 4096,
	maxArgumentPreflightDepth: 64,
	maxArgumentPreflightCharacters: 16 * 1024,
	maxLabelChars: 120,
	maxErrorBlocks: 64,
	maxErrorChars: 500,
} as const;

const encoder = new TextEncoder();

class ArgumentPreflightError extends Error {}

function boundedArgumentProjection(value: unknown): JsonObject {
	let nodes = 0;
	let characters = 0;
	const active = new Set<object>();
	const visit = (item: unknown, depth: number, inArray: boolean): unknown => {
		if (++nodes > NESTED_CALL_LIMITS.maxArgumentPreflightNodes) throw new ArgumentPreflightError();
		if (depth > NESTED_CALL_LIMITS.maxArgumentPreflightDepth) throw new ArgumentPreflightError();
		if (item === null || typeof item === "boolean" || typeof item === "number") return item;
		if (typeof item === "string") {
			characters += item.length;
			if (characters > NESTED_CALL_LIMITS.maxArgumentPreflightCharacters) throw new ArgumentPreflightError();
			return item;
		}
		if (item === undefined || typeof item === "function" || typeof item === "symbol") {
			if (inArray) return null;
			throw new ArgumentPreflightError();
		}
		if (typeof item !== "object") throw new ArgumentPreflightError();
		if (active.has(item)) throw new ArgumentPreflightError();
		active.add(item);
		try {
			if (Array.isArray(item)) {
				if (Object.getPrototypeOf(item) !== Array.prototype) throw new ArgumentPreflightError();
				const toJSON = Object.getOwnPropertyDescriptor(item, "toJSON");
				if (toJSON && (!("value" in toJSON) || typeof toJSON.value === "function")) {
					throw new ArgumentPreflightError();
				}
				const projected: unknown[] = [];
				for (let index = 0; index < item.length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
					if (descriptor && !("value" in descriptor)) throw new ArgumentPreflightError();
					projected.push(visit(descriptor?.value, depth + 1, true));
				}
				Object.setPrototypeOf(projected, null);
				return projected;
			}
			const prototype = Object.getPrototypeOf(item);
			if (prototype !== Object.prototype && prototype !== null) throw new ArgumentPreflightError();
			const projected = Object.create(null) as JsonObject;
			for (const key in item) {
				if (!Object.hasOwn(item, key)) continue;
				if (++nodes > NESTED_CALL_LIMITS.maxArgumentPreflightNodes) throw new ArgumentPreflightError();
				const descriptor = Object.getOwnPropertyDescriptor(item, key);
				if (!descriptor?.enumerable) continue;
				if (!("value" in descriptor)) throw new ArgumentPreflightError();
				if (key === "toJSON" && typeof descriptor.value === "function") throw new ArgumentPreflightError();
				characters += key.length;
				if (characters > NESTED_CALL_LIMITS.maxArgumentPreflightCharacters) throw new ArgumentPreflightError();
				const property = descriptor.value;
				if (property === undefined || typeof property === "function" || typeof property === "symbol") continue;
				Object.defineProperty(projected, key, {
					value: visit(property, depth + 1, false),
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			return projected;
		} finally {
			active.delete(item);
		}
	};

	const projection = visit(value, 0, false);
	if (!projection || typeof projection !== "object" || Array.isArray(projection)) throw new ArgumentPreflightError();
	return projection as JsonObject;
}

/** Return a bounded text excerpt for a failed nested call without retaining successful output. */
export function boundedNestedToolErrorText(result: AgentToolResult<unknown>): string {
	let excerpt = "";
	let textBlocks = 0;
	try {
		const content = result.content ?? [];
		for (
			let index = 0;
			index < Math.min(content.length, NESTED_CALL_LIMITS.maxErrorBlocks) &&
			excerpt.length < NESTED_CALL_LIMITS.maxErrorChars;
			index++
		) {
			const block = content[index];
			if (block.type !== "text") continue;
			const remaining = NESTED_CALL_LIMITS.maxErrorChars - excerpt.length;
			if (textBlocks++ > 0 && remaining > 0) excerpt += "\n";
			const textLimit = NESTED_CALL_LIMITS.maxErrorChars - excerpt.length;
			if (textLimit > 0) excerpt += (block.text ?? "").slice(0, textLimit);
		}
	} catch {
		// Malformed results must not affect completion of the nested tool call.
	}
	return excerpt;
}

/** What the nested calls of one model-issued tool call leave on its tool result message. */
export interface NestedCallSummary {
	/** Becomes `nestedCalls`. Undefined when no nested call was made. */
	calls: NestedToolCalls | undefined;
	/** Summed `usage` of the nested results, added to the message's `usage`. */
	usage: Usage | undefined;
}

/**
 * Collects the nested calls of one model-issued tool call, including calls made by nested tools.
 * The snapshot becomes `nestedCalls` on the tool result message.
 */
export class NestedCallRecorder {
	private readonly calls: NestedToolCallRecord[] = [];
	private readonly startedAt = new Map<NestedToolCallRecord, number>();
	private complete = true;
	private argumentBytes = 0;
	/** Summed usage of every nested result, including calls dropped from the record. */
	private usage: Usage | undefined;

	/** Record a call as it starts. Returns undefined when the call is dropped. */
	start(toolCall: AgentToolCall, label?: string): NestedToolCallRecord | undefined {
		if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
			this.complete = false;
			return undefined;
		}
		const record: NestedToolCallRecord = { id: toolCall.id, name: toolCall.name, status: "unfinished" };
		if (label) record.label = label.slice(0, NESTED_CALL_LIMITS.maxLabelChars);
		try {
			const projection = boundedArgumentProjection(toolCall.arguments ?? {});
			const json = JSON.stringify(projection);
			if (json === undefined) throw new ArgumentPreflightError();
			const measuredBytes = encoder.encode(json).length;
			if (
				measuredBytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall ||
				this.argumentBytes + measuredBytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal
			) {
				record.argumentsBytes = measuredBytes;
				this.complete = false;
			} else {
				record.arguments = JSON.parse(json) as JsonObject;
				this.argumentBytes += measuredBytes;
			}
		} catch {
			this.complete = false;
		}
		this.calls.push(record);
		this.startedAt.set(record, performance.now());
		return record;
	}

	finish(record: NestedToolCallRecord | undefined, isError: boolean, errorText: string): void {
		if (!record) return;
		record.status = isError ? "error" : "ok";
		record.durationMs = Math.round(performance.now() - (this.startedAt.get(record) ?? performance.now()));
		this.startedAt.delete(record);
		if (isError && errorText) record.error = errorText.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
	}

	addUsage(usage: Usage): void {
		this.usage = this.usage ? combineUsage(this.usage, usage) : usage;
	}

	get totalUsage(): Usage | undefined {
		return this.usage;
	}

	/** Copy of the record so far, or undefined when no nested call was made. */
	snapshot(): NestedToolCalls | undefined {
		if (this.calls.length === 0 && this.complete) return undefined;
		const calls = this.calls.map((call) => ({ ...call }));
		return { calls, complete: this.complete && calls.every((call) => call.status !== "unfinished") };
	}
}

export interface NestedToolCallOptions {
	/** Defaults to the calling tool's signal. */
	signal?: AbortSignal;
	/** Receives partial results of the nested tool, in addition to `tool_execution_update` events. */
	onUpdate?: AgentToolUpdateCallback;
}

/** `tool_execution_*` events of nested calls. */
export type NestedToolExecutionEvent =
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult<unknown>;
			parentToolCallId: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
			parentToolCallId: string;
	  };

export interface NestedToolCallHost {
	/** Tools nested calls resolve against. */
	getTools(): readonly AgentTool[];
	/** Whether every nested call runs exclusively, as when the agent executes tool calls sequentially. */
	isSequential(): boolean;
	/** Run the call through the tool pipeline, with hooks that report `parentToolCallId`. */
	runToolCall(
		toolCall: AgentToolCall,
		parentToolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: (partialResult: AgentToolResult<unknown>) => Promise<void>,
	): Promise<AgentToolCallOutcome>;
	emit(event: NestedToolExecutionEvent): Promise<void>;
}

/** Calls below one model-issued call share its recorder. */
interface CallScope {
	recorder: NestedCallRecorder;
	nextId: number;
	/** Set inside a call that holds the exclusive queue, so its own nested calls do not wait on it. */
	holdsQueue: boolean;
}

export class NestedToolCallRunner {
	private readonly host: NestedToolCallHost;
	/** Scopes by the id of the calling tool call. */
	private readonly scopes = new Map<string, CallScope>();
	/** Serializes nested calls that must not run concurrently. */
	private queueTail: Promise<void> = Promise.resolve();

	constructor(host: NestedToolCallHost) {
		this.host = host;
	}

	/**
	 * Run `name` on behalf of the call `callerId`. The nested call gets the id `<callerId>/<n>`.
	 * Never rejects for tool failures: they come back as `isError: true`.
	 */
	async execute(
		callerId: string,
		name: string,
		args: unknown,
		options: NestedToolCallOptions = {},
	): Promise<AgentToolCallOutcome> {
		let scope = this.scopes.get(callerId);
		if (!scope) {
			scope = { recorder: new NestedCallRecorder(), nextId: 1, holdsQueue: false };
			this.scopes.set(callerId, scope);
		}
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: `${callerId}/${scope.nextId++}`,
			name,
			arguments: (args ?? {}) as AgentToolCall["arguments"],
		};
		const definition = this.host.getTools().find((tool) => tool.name === name);
		const record = scope.recorder.start(toolCall, definition?.label);
		await this.host.emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: name,
			args: toolCall.arguments,
			parentToolCallId: callerId,
		});

		const exclusive = !scope.holdsQueue && (this.host.isSequential() || definition?.executionMode === "sequential");
		let release: (() => void) | undefined;
		if (exclusive) {
			const previous = this.queueTail;
			this.queueTail = new Promise((resolve) => {
				release = resolve;
			});
			await previous;
		}
		this.scopes.set(toolCall.id, {
			recorder: scope.recorder,
			nextId: 1,
			holdsQueue: scope.holdsQueue || exclusive,
		});
		let outcome: AgentToolCallOutcome;
		try {
			outcome = await this.host.runToolCall(toolCall, callerId, options.signal, async (partialResult) => {
				options.onUpdate?.(partialResult);
				await this.host.emit({
					type: "tool_execution_update",
					toolCallId: toolCall.id,
					toolName: name,
					args: toolCall.arguments,
					partialResult,
					parentToolCallId: callerId,
				});
			});
		} finally {
			this.scopes.delete(toolCall.id);
			release?.();
		}

		scope.recorder.finish(record, outcome.isError, outcome.isError ? boundedNestedToolErrorText(outcome.result) : "");
		// Nested results are not persisted, so their usage is only counted through the recorder.
		if (outcome.result.usage) scope.recorder.addUsage(outcome.result.usage);
		await this.host.emit({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: name,
			result: outcome.result,
			isError: outcome.isError,
			parentToolCallId: callerId,
		});
		return outcome;
	}

	/** Remove and return the record of the nested calls a model-issued call made. */
	takeRecord(toolCallId: string): NestedCallSummary | undefined {
		const scope = this.scopes.get(toolCallId);
		this.scopes.delete(toolCallId);
		if (!scope) return undefined;
		return { calls: scope.recorder.snapshot(), usage: scope.recorder.totalUsage };
	}

	clear(): void {
		this.scopes.clear();
	}
}
