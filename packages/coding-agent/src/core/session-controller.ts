import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { SessionEntry } from "./session-manager.ts";

/** Model details safe to expose as part of a live session projection. */
export interface SessionControllerModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

/** A copied view of the active transcript and current run state. */
export interface SessionControllerSnapshot {
	sessionId: string;
	sessionName?: string;
	model?: SessionControllerModel;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	entries: SessionEntry[];
	streamingMessage?: AgentMessage;
	queue: {
		steering: string[];
		followUp: string[];
	};
}

export interface SessionControllerSnapshotOptions {
	/** Return at most this many active transcript entries, taking the most recent entries (default: 200). */
	entryLimit?: number;
}

export interface SessionControllerPromptOptions {
	/** Queue the prompt while a run is active. Required when streaming. */
	deliverAs?: "steer" | "followUp";
}

export type SessionControllerPromptAcceptance = { accepted: true } | { accepted: false; reason: string };

/**
 * Narrow control surface for an already-running AgentSession. Events are copied
 * from the session's existing ordered event stream.
 */
export interface SessionController {
	getSnapshot(options?: SessionControllerSnapshotOptions): SessionControllerSnapshot;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(
		content: string | (TextContent | ImageContent)[],
		options?: SessionControllerPromptOptions,
	): Promise<SessionControllerPromptAcceptance>;
	abort(): Promise<void>;
	clearQueue(): { steering: string[]; followUp: string[] };
}

/** Project a model without exposing request configuration, headers, or credentials. */
export function projectSessionControllerModel(model: Model<Api> | undefined): SessionControllerModel | undefined {
	if (!model) return undefined;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

/** Bound and normalize preflight failures for callers that show submission receipts. */
export function sessionControllerErrorReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const bounded = message
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 256);
	return bounded || "Prompt rejected before acceptance";
}
