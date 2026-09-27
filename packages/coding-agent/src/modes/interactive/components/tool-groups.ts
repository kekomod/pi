import type { Component } from "@earendil-works/pi-tui";
import type { ToolGroupPresentation, ToolGroupRenderContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";

/** The small native control surface needed to coordinate tool group state. */
export interface ToolGroupMemberControl {
	getGroupExpanded(): boolean;
	getGroupPending(): boolean;
	getGroupFailed(): boolean;
	getGroupStartTimeMs(): number | undefined;
	getGroupEndTimeMs(): number | undefined;
	setExpanded(expanded: boolean): void;
	setToolGroupMembership(membership: ToolGroupMembership | undefined): void;
	invalidateGroupHeader(): void;
}

/** Membership attached to one native tool execution. */
export interface ToolGroupMembership {
	readonly key: string;
	readonly index: number;
	readonly size: number;
	renderHeader(theme: Theme): Component | undefined;
	update(source?: ToolGroupMemberControl): void;
	detach(): void;
}

interface MemberSnapshot {
	expanded: boolean;
	pending: boolean;
	failed: boolean;
	startTimeMs: number | undefined;
	endTimeMs: number | undefined;
}

interface GroupEntry {
	readonly control: ToolGroupMemberControl;
	readonly membership: ToolGroupMembership;
	index: number;
	snapshot: MemberSnapshot;
}

class ToolGroupState {
	private readonly entries: GroupEntry[] = [];
	readonly key: string;
	private readonly presentation: ToolGroupPresentation;
	private readonly scheduleRefresh: (group: ToolGroupState) => void;
	private readonly onEmpty: (group: ToolGroupState) => void;
	private expandedCount = 0;
	private pendingCount = 0;
	private failedCount = 0;
	private timedCount = 0;
	private earliestStartTimeMs: number | undefined;
	private latestEndTimeMs: number | undefined;

	constructor(
		key: string,
		presentation: ToolGroupPresentation,
		scheduleRefresh: (group: ToolGroupState) => void,
		onEmpty: (group: ToolGroupState) => void,
	) {
		this.key = key;
		this.presentation = presentation;
		this.scheduleRefresh = scheduleRefresh;
		this.onEmpty = onEmpty;
	}

	add(control: ToolGroupMemberControl): ToolGroupMembership {
		const group = this;
		let entry: GroupEntry;
		const membership: ToolGroupMembership = {
			key: this.key,
			get index() {
				return entry.index;
			},
			get size() {
				return group.entries.length;
			},
			renderHeader: (theme) => this.renderHeader(entry, theme),
			update: (source) => this.update(entry, source),
			detach: () => this.remove(entry),
		};
		entry = { control, membership, index: this.entries.length, snapshot: this.snapshot(control) };
		this.entries.push(entry);
		this.adjust(entry.snapshot, 1);
		this.includeTiming(entry.snapshot);
		return membership;
	}

	refreshHeader(): void {
		this.entries[0]?.control.invalidateGroupHeader();
	}

	private renderHeader(entry: GroupEntry, theme: Theme): Component | undefined {
		if (entry.membership.index !== 0) return undefined;
		try {
			return this.presentation.renderHeader(this.context(), theme);
		} catch {
			return undefined;
		}
	}

	private context(): ToolGroupRenderContext {
		return {
			key: this.key,
			size: this.entries.length,
			...(this.elapsedMs() !== undefined ? { elapsedMs: this.elapsedMs() } : {}),
			pending: this.pendingCount,
			failed: this.failedCount,
			expanded: this.entries.length > 0 && this.expandedCount === this.entries.length,
			setExpanded: (expanded) => this.setExpanded(expanded),
		};
	}

	private setExpanded(expanded: boolean): void {
		for (const entry of this.entries) {
			entry.control.setExpanded(expanded);
		}
	}

	private update(entry: GroupEntry, source?: ToolGroupMemberControl): void {
		const snapshot = this.snapshot(entry.control);
		if (
			snapshot.expanded === entry.snapshot.expanded &&
			snapshot.pending === entry.snapshot.pending &&
			snapshot.failed === entry.snapshot.failed &&
			snapshot.startTimeMs === entry.snapshot.startTimeMs &&
			snapshot.endTimeMs === entry.snapshot.endTimeMs
		)
			return;

		const previousExpanded = this.entries.length > 0 && this.expandedCount === this.entries.length;
		const previousPending = this.pendingCount;
		const previousFailed = this.failedCount;
		const previousElapsedMs = this.elapsedMs();
		const previousTimedCount = this.timedCount;
		const previousSnapshot = entry.snapshot;
		this.adjust(previousSnapshot, -1);
		this.adjust(snapshot, 1);
		entry.snapshot = snapshot;
		if (snapshot.startTimeMs !== previousSnapshot.startTimeMs || snapshot.endTimeMs !== previousSnapshot.endTimeMs) {
			this.includeTiming(snapshot);
		}
		const expanded = this.entries.length > 0 && this.expandedCount === this.entries.length;
		if (
			(previousExpanded !== expanded ||
				previousPending !== this.pendingCount ||
				previousFailed !== this.failedCount ||
				previousElapsedMs !== this.elapsedMs() ||
				previousTimedCount !== this.timedCount) &&
			this.entries[0]?.control !== source
		) {
			this.scheduleRefresh(this);
		}
	}

	private remove(entry: GroupEntry): void {
		const index = entry.index;
		if (this.entries[index] !== entry) return;

		const previousPending = this.pendingCount;
		const previousFailed = this.failedCount;
		const previousExpanded = this.entries.length > 0 && this.expandedCount === this.entries.length;
		const previousElapsedMs = this.elapsedMs();
		this.entries.splice(index, 1);
		this.adjust(entry.snapshot, -1);
		if (
			entry.snapshot.startTimeMs === this.earliestStartTimeMs ||
			entry.snapshot.endTimeMs === this.latestEndTimeMs
		) {
			this.recomputeTimingBounds();
		}
		for (let movedIndex = index; movedIndex < this.entries.length; movedIndex++) {
			const moved = this.entries[movedIndex];
			if (!moved) continue;
			moved.index = movedIndex;
			moved.control.setToolGroupMembership(moved.membership);
		}
		entry.index = -1;
		const expanded = this.entries.length > 0 && this.expandedCount === this.entries.length;
		if (
			previousExpanded !== expanded ||
			previousPending !== this.pendingCount ||
			previousFailed !== this.failedCount ||
			previousElapsedMs !== this.elapsedMs() ||
			index === 0
		) {
			this.scheduleRefresh(this);
		}
		if (this.entries.length === 0) this.onEmpty(this);
	}

	retire(): void {
		const entries = this.entries.splice(0);
		this.expandedCount = 0;
		this.pendingCount = 0;
		this.failedCount = 0;
		this.timedCount = 0;
		this.earliestStartTimeMs = undefined;
		this.latestEndTimeMs = undefined;
		for (const entry of entries) {
			entry.index = -1;
			entry.control.setToolGroupMembership(undefined);
		}
		this.onEmpty(this);
	}

	private snapshot(control: ToolGroupMemberControl): MemberSnapshot {
		return {
			expanded: control.getGroupExpanded(),
			pending: control.getGroupPending(),
			failed: control.getGroupFailed(),
			startTimeMs: control.getGroupStartTimeMs(),
			endTimeMs: control.getGroupEndTimeMs(),
		};
	}

	private adjust(snapshot: MemberSnapshot, direction: 1 | -1): void {
		if (snapshot.expanded) this.expandedCount += direction;
		if (snapshot.pending) this.pendingCount += direction;
		if (snapshot.failed) this.failedCount += direction;
		if (!snapshot.pending && snapshot.startTimeMs !== undefined && snapshot.endTimeMs !== undefined) {
			this.timedCount += direction;
		}
	}

	private elapsedMs(): number | undefined {
		if (this.entries.length === 0 || this.timedCount !== this.entries.length) return undefined;
		if (this.earliestStartTimeMs === undefined || this.latestEndTimeMs === undefined) return undefined;
		const elapsedMs = this.latestEndTimeMs - this.earliestStartTimeMs;
		return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
	}

	private includeStartTime(startTimeMs: number): void {
		if (this.earliestStartTimeMs === undefined || startTimeMs < this.earliestStartTimeMs) {
			this.earliestStartTimeMs = startTimeMs;
		}
	}

	private includeEndTime(endTimeMs: number): void {
		if (this.latestEndTimeMs === undefined || endTimeMs > this.latestEndTimeMs) {
			this.latestEndTimeMs = endTimeMs;
		}
	}

	private includeTiming(snapshot: MemberSnapshot): void {
		if (snapshot.startTimeMs !== undefined) this.includeStartTime(snapshot.startTimeMs);
		if (snapshot.endTimeMs !== undefined) this.includeEndTime(snapshot.endTimeMs);
	}

	private recomputeTimingBounds(): void {
		this.earliestStartTimeMs = undefined;
		this.latestEndTimeMs = undefined;
		for (const entry of this.entries) {
			const { startTimeMs, endTimeMs } = entry.snapshot;
			if (startTimeMs !== undefined) this.includeStartTime(startTimeMs);
			if (endTimeMs !== undefined) this.includeEndTime(endTimeMs);
		}
	}
}

/** Coordinates adjacent native tool rows without changing their component hierarchy. */
export class ToolGroupCoordinator {
	private presentation: ToolGroupPresentation | undefined;
	private currentGroup: ToolGroupState | undefined;
	private readonly groups = new Set<ToolGroupState>();
	private updateDepth = 0;
	private readonly pendingRefresh = new Set<ToolGroupState>();

	constructor(presentation?: ToolGroupPresentation) {
		this.presentation = presentation;
	}

	setPresentation(presentation: ToolGroupPresentation | undefined): void {
		this.reset();
		this.presentation = presentation;
	}

	/** Clear the active sequence and detach every group membership, retaining tool components themselves. */
	reset(): void {
		this.currentGroup = undefined;
		for (const group of [...this.groups]) group.retire();
		this.pendingRefresh.clear();
	}

	/** End adjacency for the next tool while keeping already-rendered groups intact. */
	break(): void {
		this.currentGroup = undefined;
	}

	beginUpdate(): void {
		this.updateDepth++;
	}

	endUpdate(): void {
		if (this.updateDepth === 0) return;
		this.updateDepth--;
		if (this.updateDepth > 0) return;
		for (const group of this.pendingRefresh) group.refreshHeader();
		this.pendingRefresh.clear();
	}

	add(toolName: string, control: ToolGroupMemberControl): void {
		const key = this.groupKey(toolName);
		if (key === undefined) {
			this.break();
			control.setToolGroupMembership(undefined);
			return;
		}

		const presentation = this.presentation;
		if (!presentation) {
			this.break();
			control.setToolGroupMembership(undefined);
			return;
		}
		if (!this.currentGroup || this.currentGroup.key !== key) {
			let group: ToolGroupState;
			group = new ToolGroupState(
				key,
				presentation,
				(state) => this.scheduleRefresh(state),
				(state) => {
					this.groups.delete(state);
					if (this.currentGroup === state) this.currentGroup = undefined;
				},
			);
			this.groups.add(group);
			this.currentGroup = group;
		}
		const group = this.currentGroup;
		const membership = group.add(control);
		control.setToolGroupMembership(membership);
		if (membership.index > 0) this.scheduleRefresh(group);
	}

	private groupKey(toolName: string): string | undefined {
		try {
			const key = this.presentation?.groupKey(toolName);
			return typeof key === "string" && key.length > 0 ? key : undefined;
		} catch {
			return undefined;
		}
	}

	private scheduleRefresh(group: ToolGroupState): void {
		if (this.updateDepth > 0) {
			this.pendingRefresh.add(group);
		} else {
			group.refreshHeader();
		}
	}
}
