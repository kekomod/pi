import type { EventBus } from "./event-bus.ts";

export type McpServerReadinessResolver = (name: string, signal?: AbortSignal) => Promise<void>;

const resolvers = new WeakMap<EventBus, McpServerReadinessResolver>();

/** The built-in MCP extension owns readiness and supplies the resolver for its event bus. */
export function registerMcpServerReadinessResolver(events: EventBus, resolver: McpServerReadinessResolver): () => void {
	resolvers.set(events, resolver);
	return () => {
		if (resolvers.get(events) === resolver) resolvers.delete(events);
	};
}

/** Wait for one server through the built-in MCP extension. */
export async function waitForMcpServer(events: EventBus, name: string, signal?: AbortSignal): Promise<void> {
	if (!name.trim()) throw new Error("MCP server name must not be empty");
	signal?.throwIfAborted();
	const resolver = resolvers.get(events);
	if (!resolver) {
		throw new Error("Pi's built-in MCP extension is unavailable; enable it to wait for MCP servers.");
	}
	await resolver(name, signal);
}
