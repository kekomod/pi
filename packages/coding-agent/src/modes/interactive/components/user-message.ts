import { Box, Container, Markdown, type MarkdownTheme, Spacer } from "@earendil-works/pi-tui";
import type {
	MarkdownTransformer,
	MessageLeadingComponentContext,
	MessageLeadingComponentFactory,
	MessageOutputPadding,
	MessagePresentationContext,
	MessageRegionRenderer,
	MessageRenderProjection,
	UserMessagePresentationTarget,
} from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { mergeMarkdownOptions, resolveMessageRegionPresentation } from "./message-presentation.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container implements UserMessagePresentationTarget {
	readonly role = "user" as const;
	readonly isStreaming = false;
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private projections = new Set<MessageRenderProjection>();
	private regionRenderers = new Set<MessageRegionRenderer>();
	private leadingComponentFactories = new Set<MessageLeadingComponentFactory>();
	private outputPadding?: MessageOutputPadding;
	private displayTextResolver?: (context: MessagePresentationContext) => string | undefined;

	get message(): unknown {
		return this.text;
	}

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
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

	setDisplayText(resolver: ((context: MessagePresentationContext) => string | undefined) | undefined): void {
		this.displayTextResolver = resolver;
		this.rebuild();
	}

	addLeadingComponent(factory: MessageLeadingComponentFactory): () => void {
		this.leadingComponentFactories.add(factory);
		this.invalidate();
		return () => {
			if (this.leadingComponentFactories.delete(factory)) this.invalidate();
		};
	}

	private rebuild(): void {
		this.clear();
		for (const factory of this.leadingComponentFactories) {
			try {
				const component = factory({
					role: this.role,
					message: this.message,
					isStreaming: this.isStreaming,
				} satisfies MessageLeadingComponentContext);
				if (component) this.addChild(component);
			} catch {
				// Keep native message content when an optional leading component fails.
			}
		}
		const displayText =
			this.displayTextResolver?.({
				role: this.role,
				message: this.message,
				isStreaming: this.isStreaming,
			}) ?? this.text;
		const presentation = resolveMessageRegionPresentation(this.regionRenderers, {
			role: this.role,
			region: "text",
			index: 0,
			text: displayText,
			message: this.message,
			isStreaming: this.isStreaming,
		});
		const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
		for (let spacing = 0; spacing < presentation.leadingSpacing; spacing++) {
			contentBox.addChild(new Spacer(1));
		}
		contentBox.addChild(
			new Markdown(
				presentation.text,
				0,
				0,
				{ ...this.markdownTheme, ...presentation.markdownTheme },
				{
					color: (content: string) => theme.fg("userMessageText", content),
					...presentation.defaultTextStyle,
				},
				mergeMarkdownOptions(
					{
						preserveOrderedListMarkers: true,
						preserveBackslashEscapes: true,
						transform: createMarkdownTransform("user", false, this.markdownTransformers),
					},
					presentation.markdownOptions,
				),
			),
		);
		this.addChild(contentBox);
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

	addRenderProjection(projection: MessageRenderProjection): () => void {
		this.projections.add(projection);
		this.invalidate();
		return () => {
			if (this.projections.delete(projection)) this.invalidate();
		};
	}

	private renderNative(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	override render(width: number): string[] {
		this.applyOutputPadding(width);
		let lines = this.renderNative(width);
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
}
