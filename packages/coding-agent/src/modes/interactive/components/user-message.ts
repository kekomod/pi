import {
	Box,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	MarkdownTransformer,
	MessageLeadingComponentContext,
	MessageLeadingComponentFactory,
	MessageNativeWidthResolver,
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

function escapeLiteralControls(text: string): string {
	return text.replace(
		/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
		(character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);
}

export interface UserMessageComponentOptions {
	readonly literal?: boolean;
	readonly literalTextStyle?: (content: string) => string;
}

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
	private nativeWidthResolver?: MessageNativeWidthResolver;
	private nativeLayout?: { readonly outerWidth: number; readonly nativeWidth: number };
	private displayTextResolver?: (context: MessagePresentationContext) => string | undefined;
	private builtDisplayText: string;
	private builtDisplayWidth: number | undefined;
	private readonly literal: boolean;
	private readonly literalTextStyle?: (content: string) => string;

	get message(): unknown {
		return this.text;
	}

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		options: UserMessageComponentOptions = {},
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.literal = options.literal === true;
		this.literalTextStyle = options.literalTextStyle;
		this.builtDisplayText = text;
		this.builtDisplayWidth = undefined;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	override invalidate(): void {
		this.nativeLayout = undefined;
		super.invalidate();
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

	private resolveDisplayText(width: number): string {
		return (
			this.displayTextResolver?.({
				role: this.role,
				message: this.message,
				isStreaming: this.isStreaming,
				width,
			}) ?? this.text
		);
	}

	private rebuild(width?: number, resolvedText?: string): void {
		this.nativeLayout = undefined;
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
		const displayText = resolvedText ?? (width === undefined ? this.text : this.resolveDisplayText(width));
		this.builtDisplayText = displayText;
		this.builtDisplayWidth = width;
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
		if (this.literal) {
			contentBox.addChild(
				new Text(
					escapeLiteralControls(presentation.text),
					0,
					0,
					this.literalTextStyle ?? ((content) => theme.fg("userMessageText", content)),
				),
			);
		} else {
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
		}
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
			return visible >= width
				? truncateToWidth(line, width)
				: line + theme.bg("userMessageBg", " ".repeat(width - visible));
		});
	}

	override render(width: number): string[] {
		this.applyOutputPadding(width);
		if (this.displayTextResolver) {
			const displayText = this.resolveDisplayText(width);
			if (this.builtDisplayWidth !== width || this.builtDisplayText !== displayText) {
				this.rebuild(width, displayText);
			}
		}
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
}
