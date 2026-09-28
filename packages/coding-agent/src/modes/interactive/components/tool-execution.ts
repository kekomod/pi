import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type {
	ToolDefinition,
	ToolGroupMemberRenderContext,
	ToolImagePresentation,
	ToolImageRenderContext,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../../../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";
import type { ToolGroupCoordinator, ToolGroupMemberControl, ToolGroupMembership } from "./tool-groups.ts";

/**
 * What this component needs from a tool: how to draw it. It neither executes tools nor reads their
 * parameter schemas, so a definition and a bare renderer pair are equally acceptable.
 *
 * The renderer parameters are `any` on purpose: a `ToolDefinition` types them from its schema, and
 * narrowing them here would make those definitions unassignable.
 */
export interface ToolRenderers {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
	renderResult?: (
		result: AgentToolResult<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<any, any>,
	) => Component;
}

import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

const FALLBACK_PREVIEW_LINES = 10;
const DEFAULT_IMAGE_SPACING_ROWS = 1;
const MAX_IMAGE_SPACING_ROWS = 10;

interface ToolImageHost {
	renderPresentedImage(image: Image, index: number, width: number): string[];
	handlePresentedImageMouse(index: number, event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

class ToolGroupSpacer implements Component {
	private readonly owner: ToolExecutionComponent;

	constructor(owner: ToolExecutionComponent) {
		this.owner = owner;
	}

	render(): string[] {
		return this.owner.hasGroupLeadingSpacer() ? [""] : [];
	}

	invalidate(): void {}
}

function resolveImageRenderWidth(presentation: ToolImagePresentation | undefined, width: number): number {
	const fallback = Math.max(1, Math.floor(width));
	if (!presentation?.getRenderWidth) return fallback;
	try {
		const candidate = presentation.getRenderWidth(width);
		if (!Number.isFinite(candidate)) return fallback;
		return Math.max(1, Math.min(fallback, Math.floor(candidate)));
	} catch {
		return fallback;
	}
}

function resolveImageSpacingRows(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_IMAGE_SPACING_ROWS;
	return Math.min(MAX_IMAGE_SPACING_ROWS, Math.max(0, Math.floor(value)));
}

/** Keeps image presentation in the normal Component tree for both shell modes. */
class ToolImageView implements Component {
	private readonly host: ToolImageHost;
	private readonly image: Image;
	private readonly index: number;

	constructor(host: ToolImageHost, image: Image, index: number) {
		this.host = host;
		this.image = image;
		this.index = index;
	}

	render(width: number): string[] {
		return this.host.renderPresentedImage(this.image, this.index, width);
	}

	invalidate(): void {
		this.image.invalidate();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.host.handlePresentedImageMouse(this.index, event);
	}
}

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	imagePresentation?: ToolImagePresentation;
	groupCoordinator?: ToolGroupCoordinator;
}

export class ToolExecutionComponent extends Container implements ToolImageHost, ToolGroupMemberControl {
	private contentBox: Box;
	private contentText: Text;
	private contentTextRegion: MouseRegion;
	private selfRenderContainer: Container;
	private selfGroupContainer: Container;
	private groupHeaderContainer: Container;
	private selfRenderHeight = 0;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageViews: ToolImageView[] = [];
	private lastRenderedImageIndex: number | undefined;
	private imageSpacers: Spacer[] = [];
	private imagePresentation?: ToolImagePresentation;
	private imageFrames = new Map<number, { context: ToolImageRenderContext; lines: string[] }>();
	private imageLayout: Array<{ index: number; startY: number; height: number }> = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolRenderers;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private executionStartTimeMs: number | undefined;
	private executionEndTimeMs: number | undefined;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<
		number,
		{ sourceData: string; sourceMimeType: string; data: string; mimeType: string }
	> = new Map();
	private hideComponent = false;
	private groupCoordinator?: ToolGroupCoordinator;
	private groupMembership?: ToolGroupMembership;
	private initialized = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.imagePresentation = options.imagePresentation;
		this.groupCoordinator = options.groupCoordinator;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new ToolGroupSpacer(this));
		this.groupHeaderContainer = new Container();

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentTextRegion = this.createResultRegion(this.contentText);
		this.selfRenderContainer = new Container();
		this.selfGroupContainer = new Container();
		this.selfGroupContainer.addChild(this.groupHeaderContainer);
		this.selfGroupContainer.addChild(this.selfRenderContainer);

		if (this.hasRendererDefinition()) {
			if (this.getRenderShell() === "self") {
				this.addChild(this.selfGroupContainer);
			} else {
				this.addChild(this.groupHeaderContainer);
				this.addChild(this.contentBox);
			}
		} else {
			this.addChild(this.groupHeaderContainer);
			this.addChild(this.contentTextRegion);
		}

		if (this.groupCoordinator) this.groupCoordinator.add(this.toolName, this);
		this.initialized = true;
		this.updateDisplay();
	}

	hasGroupLeadingSpacer(): boolean {
		return this.groupMembership === undefined || this.groupMembership.index === 0;
	}

	getGroupExpanded(): boolean {
		return this.expanded;
	}

	getGroupPending(): boolean {
		return this.isPartial;
	}

	getGroupFailed(): boolean {
		return this.result?.isError ?? false;
	}

	getGroupStartTimeMs(): number | undefined {
		return this.executionStartTimeMs;
	}

	getGroupEndTimeMs(): number | undefined {
		return this.executionEndTimeMs;
	}

	setToolGroupMembership(membership: ToolGroupMembership | undefined): void {
		this.groupMembership = membership;
		if (this.initialized) {
			this.updateDisplay(true);
			this.ui.requestRender();
		}
	}

	setToolGroupCoordinator(coordinator: ToolGroupCoordinator | undefined): void {
		if (this.groupMembership) this.groupMembership.detach();
		this.groupMembership = undefined;
		this.groupCoordinator = coordinator;
		if (coordinator) coordinator.add(this.toolName, this);
		else if (this.initialized) {
			this.updateDisplay(true);
			this.ui.requestRender();
		}
	}

	invalidateGroupHeader(): void {
		this.updateGroupHeader();
		this.ui.requestRender();
	}

	private updateGroupHeader(): void {
		this.groupHeaderContainer.clear();
		if (this.groupMembership?.index !== 0) return;
		const header = this.groupMembership.renderHeader(theme);
		if (header) this.groupHeaderContainer.addChild(header);
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		return this.toolDefinition?.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		return this.toolDefinition?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		return this.toolDefinition?.renderShell ?? "default";
	}

	getToolName(): string {
		return this.toolName;
	}

	setImagePresentation(presentation: ToolImagePresentation | undefined): void {
		this.imagePresentation = presentation;
		this.updateDisplay();
		this.ui.requestRender();
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		const group = this.createGroupRenderContext();
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			hasRenderedImages: this.imageViews.length > 0,
			isError: this.result?.isError ?? false,
			...(group ? { group } : {}),
		};
	}

	private createGroupRenderContext(): ToolGroupMemberRenderContext | undefined {
		const membership = this.groupMembership;
		if (!membership) return undefined;
		return {
			key: membership.key,
			get index() {
				return membership.index;
			},
			get size() {
				return membership.size;
			},
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		});
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(startTimeMs?: number): void {
		this.executionStarted = true;
		if (this.executionStartTimeMs === undefined && Number.isFinite(startTimeMs)) {
			this.executionStartTimeMs = startTimeMs;
		}
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
		endTimeMs?: number,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		if (!isPartial && this.executionEndTimeMs === undefined && Number.isFinite(endTimeMs)) {
			this.executionEndTimeMs = endTimeMs;
		}
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			const sourceData = img.data;
			const sourceMimeType = img.mimeType;
			if (sourceMimeType === "image/png") continue;
			const cached = this.convertedImages.get(i);
			if (cached?.sourceData === sourceData && cached.sourceMimeType === sourceMimeType) continue;

			const index = i;
			convertToPng(sourceData, sourceMimeType).then((converted) => {
				const currentImage = this.result?.content.filter((content) => content.type === "image")[index];
				if (!converted || currentImage?.data !== sourceData || currentImage.mimeType !== sourceMimeType) return;
				this.convertedImages.set(index, {
					sourceData,
					sourceMimeType,
					...converted,
				});
				this.updateDisplay();
				this.ui.requestRender();
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	renderPresentedImage(image: Image, index: number, width: number): string[] {
		const renderWidth = resolveImageRenderWidth(this.imagePresentation, width);
		const nativeLines = image.render(renderWidth);
		const group = this.createGroupRenderContext();
		const context: ToolImageRenderContext = {
			index,
			width,
			renderWidth,
			expanded: this.expanded,
			hasOverlay: this.ui.hasOverlay(),
			isLastImage: index === this.lastRenderedImageIndex,
			nativeLines,
			bounds: { width: renderWidth, height: nativeLines.length },
			...(group ? { group } : {}),
			setExpanded: (expanded) => this.setExpanded(expanded),
		};
		let lines: string[];
		try {
			lines = this.imagePresentation?.render?.(context, theme) ?? [...nativeLines];
		} catch {
			lines = [...nativeLines];
		}
		this.imageFrames.set(index, {
			context: { ...context, bounds: { width, height: lines.length } },
			lines,
		});
		return lines;
	}

	handlePresentedImageMouse(index: number, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const frame = this.imageFrames.get(index);
		const onClick = this.imagePresentation?.onClick;
		if (!frame || !onClick || event.type !== "click" || event.button !== "left") return undefined;
		let handled: boolean | undefined;
		try {
			handled = onClick({ ...frame.context, x: event.x, y: event.y });
		} catch {
			return undefined;
		}
		return handled ? { handled: true } : undefined;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfGroupContainer.render(width);
			this.selfRenderHeight = contentLines.length;
			this.imageLayout = [];
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (this.hasGroupLeadingSpacer() && contentLines.length > 0) {
				lines.push("");
			}
			lines.push(...contentLines);
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageView = this.imageViews[i];
				if (imageView) {
					const startY = lines.length;
					const imageLines = imageView.render(width);
					lines.push(...imageLines);
					this.imageLayout.push({ index: i, startY, height: imageLines.length });
				}
			}
			return lines;
		}

		return super.render(width);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (!this.hasRendererDefinition() || this.getRenderShell() !== "self") return super.handleMouse(event);
		const leading = this.hasGroupLeadingSpacer() ? 1 : 0;
		if (event.y >= leading && event.y < this.selfRenderHeight + leading) {
			return this.selfGroupContainer.handleMouse({
				...event,
				y: event.y - leading,
				height: this.selfRenderHeight,
			});
		}
		for (const layout of this.imageLayout) {
			if (event.y >= layout.startY && event.y < layout.startY + layout.height) {
				const imageView = this.imageViews[layout.index];
				if (!imageView) return undefined;
				const imageEvent = {
					...event,
					y: event.y - layout.startY,
					height: layout.height,
				};
				const result = imageView.handleMouse(imageEvent);
				return result?.handled
					? {
							...result,
							handled: true,
							target: {
								component: imageView,
								originX: event.screenX - event.x,
								originY: imageEvent.screenY - imageEvent.y,
								width: event.width,
								height: layout.height,
							},
						}
					: undefined;
			}
		}
		return undefined;
	}

	private updateDisplay(preserveImages = false): void {
		this.groupMembership?.update(this);
		this.updateGroupHeader();
		if (!preserveImages) this.updateImageViews();
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(this.createResultRegion(component));
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(this.createResultRegion(component));
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private updateImageViews(): void {
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const imageView of this.imageViews) {
			this.removeChild(imageView);
		}
		this.imageViews = [];
		this.lastRenderedImageIndex = undefined;
		this.imageFrames.clear();
		this.imageLayout = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const cached = this.convertedImages.get(i);
					const converted =
						cached?.sourceData === img.data && cached.sourceMimeType === img.mimeType ? cached : undefined;
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacingRows = resolveImageSpacingRows(this.imagePresentation?.spacingRows);
					if (spacingRows > 0) {
						const spacer = new Spacer(spacingRows);
						this.addChild(spacer);
						this.imageSpacers.push(spacer);
					}
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{
							maxWidthCells: this.imageWidthCells,
							maxHeightCells:
								!this.expanded && this.imagePresentation?.previewHeightCells !== undefined
									? Math.max(1, this.imagePresentation.previewHeightCells)
									: undefined,
						},
					);
					this.imageComponents.push(imageComponent);
					const imageView = new ToolImageView(this, imageComponent, i);
					this.imageViews.push(imageView);
					this.lastRenderedImageIndex = i;
					this.addChild(imageView);
				}
			}
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
