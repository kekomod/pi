import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	AssistantMessagePresentationTarget,
	MarkdownTransformer,
	MessageLeadingComponentContext,
	MessageLeadingComponentFactory,
	MessageNativeWidthResolver,
	MessageOutputPadding,
	MessageRegionRenderer,
	MessageRenderProjection,
} from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { mergeMarkdownOptions, resolveMessageRegionPresentation } from "./message-presentation.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container implements AssistantMessagePresentationTarget {
	readonly role = "assistant" as const;
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private projections = new Set<MessageRenderProjection>();
	private regionRenderers = new Set<MessageRegionRenderer>();
	private leadingComponentFactories = new Set<MessageLeadingComponentFactory>();
	private outputPadding?: MessageOutputPadding;
	private nativeWidthResolver?: MessageNativeWidthResolver;
	private nativeLayout?: { readonly outerWidth: number; readonly nativeWidth: number };

	get message(): unknown {
		return this.lastMessage;
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	private streaming = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		this.nativeLayout = undefined;
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	addRegionPresentation(renderer: MessageRegionRenderer): () => void {
		this.regionRenderers.add(renderer);
		this.invalidate();
		return () => {
			if (this.regionRenderers.delete(renderer)) this.invalidate();
		};
	}

	setOutputPadding(padding: MessageOutputPadding | undefined): void {
		this.outputPadding = padding;
		this.invalidate();
	}

	setNativeRenderWidth(resolver: MessageNativeWidthResolver | undefined): void {
		this.nativeWidthResolver = resolver;
		this.invalidate();
	}

	addLeadingComponent(factory: MessageLeadingComponentFactory): () => void {
		this.leadingComponentFactories.add(factory);
		this.invalidate();
		return () => {
			if (this.leadingComponentFactories.delete(factory)) this.invalidate();
		};
	}

	addRenderProjection(projection: MessageRenderProjection): () => void {
		this.projections.add(projection);
		this.invalidate();
		return () => {
			if (this.projections.delete(projection)) this.invalidate();
		};
	}

	private renderNative(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	private applyOutputPadding(width: number): void {
		const padding =
			typeof this.outputPadding === "function"
				? this.outputPadding({
						role: this.role,
						message: this.message,
						isStreaming: this.isStreaming,
						width,
						defaultPadding: this.outputPad,
					})
				: this.outputPadding;
		if (padding !== undefined && Number.isFinite(padding) && padding !== this.outputPad) {
			this.setOutputPad(Math.max(0, Math.floor(padding)));
		}
	}

	private resolveNativeRender(width: number): { readonly lines: string[]; readonly nativeWidth: number } {
		const cached = this.nativeLayout;
		if (cached?.outerWidth === width) {
			return { lines: this.renderNative(cached.nativeWidth), nativeWidth: cached.nativeWidth };
		}
		const initial = this.renderNative(width);
		let nativeWidth = width;
		try {
			const candidate = this.nativeWidthResolver?.({
				role: this.role,
				message: this.message,
				isStreaming: this.isStreaming,
				width,
				nativeLines: initial,
			});
			if (candidate !== undefined && Number.isFinite(candidate))
				nativeWidth = Math.max(1, Math.min(width, Math.floor(candidate)));
		} catch {
			// Keep the full-width native message when an optional resolver fails.
		}
		this.nativeLayout = { outerWidth: width, nativeWidth };
		if (nativeWidth === width) return { lines: initial, nativeWidth };
		return { lines: this.renderNative(nativeWidth), nativeWidth };
	}

	private padNativeLines(lines: readonly string[], width: number): string[] {
		return lines.map((line) => {
			const visible = visibleWidth(line);
			return visible >= width ? truncateToWidth(line, width) : line + " ".repeat(width - visible);
		});
	}

	override render(width: number): string[] {
		this.applyOutputPadding(width);
		const native = this.resolveNativeRender(width);
		this.nativeLayout = { outerWidth: width, nativeWidth: native.nativeWidth };
		let lines = native.nativeWidth === width ? native.lines : this.padNativeLines(native.lines, width);
		for (const projection of this.projections) {
			try {
				lines =
					projection({
						role: this.role,
						message: this.message,
						isStreaming: this.isStreaming,
						width,
						nativeLines: lines,
					}) ?? lines;
			} catch {
				// Keep the native transcript visible if an extension projection fails.
			}
		}
		return lines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const nativeWidth = this.nativeLayout?.outerWidth === event.width ? this.nativeLayout.nativeWidth : event.width;
		return super.handleMouse({ ...event, width: nativeWidth });
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.nativeLayout = undefined;
		this.lastMessage = message;
		this.streaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}
		for (const factory of this.leadingComponentFactories) {
			try {
				const component = factory({
					role: this.role,
					message: this.message,
					isStreaming: this.isStreaming,
				} satisfies MessageLeadingComponentContext);
				if (component) this.contentContainer.addChild(component);
			} catch {
				// Keep native message content when an optional leading component fails.
			}
		}

		// Render content in order
		let thinkingRunIndex = 0;
		let textRegionIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				const presentation = resolveMessageRegionPresentation(this.regionRenderers, {
					role: this.role,
					region: "text",
					index: textRegionIndex++,
					text: content.text.trim(),
					message: this.message,
					isStreaming: this.isStreaming,
				});
				for (let spacing = 0; spacing < presentation.leadingSpacing; spacing++) {
					this.contentContainer.addChild(new Spacer(1));
				}
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(
						presentation.text,
						this.outputPad,
						0,
						{ ...this.markdownTheme, ...presentation.markdownTheme },
						presentation.defaultTextStyle,
						mergeMarkdownOptions(
							{ transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers) },
							presentation.markdownOptions,
						),
					),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				const presentation = resolveMessageRegionPresentation(this.regionRenderers, {
					role: this.role,
					region: "thinking",
					index: runIndex,
					text: thinkingBlocks.join("\n\n"),
					message: this.message,
					isStreaming: this.isStreaming,
				});
				for (let spacing = 0; spacing < presentation.leadingSpacing; spacing++) {
					this.contentContainer.addChild(new Spacer(1));
				}
				const thinkingComponent = hidden
					? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
					: new Markdown(
							presentation.text,
							this.outputPad,
							0,
							{ ...this.markdownTheme, ...presentation.markdownTheme },
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
								...presentation.defaultTextStyle,
							},
							mergeMarkdownOptions(
								{
									transform: createMarkdownTransform(
										"assistant-thinking",
										this.isStreaming,
										this.markdownTransformers,
									),
								},
								presentation.markdownOptions,
							),
						);
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
