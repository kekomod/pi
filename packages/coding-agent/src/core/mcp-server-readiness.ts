import type { EventBus } from "./event-bus.ts";

export type McpServerReadinessResolver = (name: string, signal?: AbortSignal) => Promise<void>;

const REQUEST_RESOLVER = "pi:mcp:readiness-resolver";

/** The built-in MCP extension owns readiness and supplies the resolver for its event bus. */
export function registerMcpServerReadinessResolver(events: EventBus, resolver: McpServerReadinessResolver): () => void {
	return events.on(REQUEST_RESOLVER, (request) => {
		if (typeof request === "function") request(resolver);
	});
}

/** Wait for one server through the built-in MCP extension. */
export async function waitForMcpServer(events: EventBus, name: string, signal?: AbortSignal): Promise<void> {
	if (!name.trim()) throw new Error("MCP server name must not be empty");
	signal?.throwIfAborted();
	let pending: Promise<void> | undefined;
	events.emit(REQUEST_RESOLVER, (resolver: McpServerReadinessResolver) => {
		pending = resolver(name, signal);
	});
	if (!pending) {
		throw new Error("Pi's built-in MCP extension is unavailable; enable it to wait for MCP servers.");
	}
	await pending;
}
