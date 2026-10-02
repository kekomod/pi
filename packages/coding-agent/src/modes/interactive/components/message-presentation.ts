import type { DefaultTextStyle, MarkdownOptions, MarkdownTheme } from "@earendil-works/pi-tui";
import type {
	MessageRegionContext,
	MessageRegionPresentation,
	MessageRegionRenderer,
} from "../../../core/extensions/types.ts";

export interface ResolvedMessageRegionPresentation {
	readonly text: string;
	readonly leadingSpacing: number;
	readonly markdownTheme?: Partial<MarkdownTheme>;
	readonly defaultTextStyle?: Partial<DefaultTextStyle>;
	readonly markdownOptions?: MarkdownOptions;
}

export function mergeMarkdownOptions(
	current: MarkdownOptions | undefined,
	next: MarkdownOptions | undefined,
): MarkdownOptions | undefined {
	if (!current) return next;
	if (!next) return current;

	const merged: MarkdownOptions = { ...current, ...next };
	if (current.transform && next.transform) {
		merged.transform = (markdown, availableWidth) =>
			next.transform?.(current.transform?.(markdown, availableWidth) ?? markdown, availableWidth) ?? markdown;
	}
	return merged;
}

export function resolveMessageRegionPresentation(
	renderers: Iterable<MessageRegionRenderer>,
	context: MessageRegionContext,
): ResolvedMessageRegionPresentation {
	let text = context.text;
	let leadingSpacing = 0;
	let markdownTheme: Partial<MarkdownTheme> | undefined;
	let defaultTextStyle: Partial<DefaultTextStyle> | undefined;
	let markdownOptions: MarkdownOptions | undefined;

	for (const renderer of renderers) {
		let presentation: MessageRegionPresentation | undefined;
		try {
			presentation = renderer({ ...context, text });
		} catch {
			continue;
		}
		if (!presentation) continue;
		if (presentation.text !== undefined) text = presentation.text;
		if (presentation.leadingSpacing !== undefined) {
			leadingSpacing += Math.max(0, Math.floor(presentation.leadingSpacing));
		}
		if (presentation.markdownTheme) {
			markdownTheme = { ...markdownTheme, ...presentation.markdownTheme };
		}
		if (presentation.defaultTextStyle) {
			defaultTextStyle = { ...defaultTextStyle, ...presentation.defaultTextStyle };
		}
		markdownOptions = mergeMarkdownOptions(markdownOptions, presentation.markdownOptions);
	}

	return { text, leadingSpacing, markdownTheme, defaultTextStyle, markdownOptions };
}
