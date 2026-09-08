// FILE: SidebarThreadBranch.tsx
// Purpose: Shared orchestrator → subagent/batch branch wrapper used by both sidebars.
// Exports: SidebarThreadHierarchyBranch, thread-line geometry helpers, and flat-list nesting.
// Depends on: DisclosureRegion + disclosureMotion only (220ms ease-out, reduced-motion safe).

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ThreadId } from "@synara/contracts";

import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "../lib/disclosureMotion";
import { cn } from "../lib/utils";
import type { HiddenBranchSummary } from "./sidebarThreadHierarchyPresentation";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import {
  SidebarThreadBranchControl,
  SidebarThreadBranchSlot,
  type SidebarBranchSlotLayout,
} from "./SidebarThreadBranchControl";

/** Every thread row leads with a 12px provider icon (`size-3`). */
export const SIDEBAR_ROW_LEADING_ICON_PX = 12;

/**
 * Left offset of a branch's vertical thread line so it runs under the centre of
 * the parent row's provider icon: the parent's left padding plus half the icon.
 * Nested branches compute it from the child row's own padding, so each level
 * draws its own line under its own icon.
 */
export function hierarchyThreadLineOffsetPx(rowPaddingLeftPx: number): number {
  const padding = Number.isFinite(rowPaddingLeftPx) ? Math.max(0, rowPaddingLeftPx) : 0;
  return padding + SIDEBAR_ROW_LEADING_ICON_PX / 2;
}

/** Gap between the thread line and the child rows: 12px on every surface. */
const CHILD_LIST_PADDING_CLASS: Record<SidebarBranchSlotLayout, string> = {
  classic: "pl-3",
  activity: "pl-3",
};

export function branchControlsId(threadId: ThreadId, surface = "sidebar"): string {
  return `sidebar-branch-${surface}-${threadId}`;
}

export interface NestedSidebarEntry<T> {
  entry: T;
  children: NestedSidebarEntry<T>[];
}

/**
 * Nest a preorder flat list (with numeric depth) into a tree. Used to render
 * the visible rows from buildProjectThreadTree as nested <ul> branches while
 * keeping the flat list as the single source for shortcuts, navigation,
 * prewarming and PR refresh.
 */
export function nestSidebarEntriesByDepth<T extends { depth: number }>(
  entries: readonly T[],
): NestedSidebarEntry<T>[] {
  const roots: NestedSidebarEntry<T>[] = [];
  const stack: NestedSidebarEntry<T>[] = [];
  for (const entry of entries) {
    const node: NestedSidebarEntry<T> = { entry, children: [] };
    const depth = Number.isFinite(entry.depth) ? Math.max(0, Math.floor(entry.depth)) : 0;
    while (stack.length > depth) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
      stack.push(node);
      continue;
    }
    // Depth jumps larger than one level still attach to the deepest open node
    // so adversarial snapshots cannot drop rows.
    const parent = stack[stack.length - 1];
    if (!parent) {
      roots.push(node);
      stack.length = 0;
      stack.push(node);
      continue;
    }
    parent.children.push(node);
    stack.push(node);
  }
  return roots;
}

export interface SidebarThreadHierarchyBranchRenderSlot {
  /**
   * Subagent disclosure when directChildCount > 0. Classic rows reserve an
   * empty trailing slot otherwise; Activity rows render nothing (no reserved space).
   */
  branchControl: ReactNode;
  /** True for every row with logical depth greater than zero. */
  isHierarchyChild: boolean;
}

export function SidebarThreadHierarchyBranch(props: {
  threadId: ThreadId;
  title: string;
  depth: number;
  directChildCount: number;
  expanded: boolean;
  onToggle: (threadId: ThreadId) => void;
  renderRow: (slot: SidebarThreadHierarchyBranchRenderSlot) => ReactNode;
  /** Slot widths and child-list padding for the hosting surface. */
  layout: SidebarBranchSlotLayout;
  /** See hierarchyThreadLineOffsetPx: margin-left of the children list. */
  threadLineOffsetPx: number;
  hiddenSummary?: HiddenBranchSummary | undefined;
  children?: ReactNode;
  childPaging?: ReactNode;
  /**
   * Mount surface for stable aria-controls ids. Threads render once per
   * surface (a pinned family never repeats in project lists), but Pinned and
   * project lists mount simultaneously, so the id must differ per surface.
   */
  surface?: string | undefined;
}) {
  const {
    childPaging,
    children,
    depth,
    directChildCount,
    expanded,
    hiddenSummary,
    layout,
    onToggle,
    renderRow,
    surface = "sidebar",
    threadId,
    threadLineOffsetPx,
    title,
  } = props;
  const hasChildren = directChildCount > 0;
  const controlsId = branchControlsId(threadId, surface);
  const branchRef = useRef<HTMLLIElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(expanded);
  const cleanupTimerRef = useRef<number | null>(null);
  // Last committed open subtree. Tracked in a ref while open (no extra render
  // per parent update); snapshotted into state only on the open→closed
  // transition so it can play the 220ms closing animation, then released.
  const lastOpenRenderRef = useRef<{ children?: ReactNode; paging?: ReactNode } | null>(null);
  const [retained, setRetained] = useState<{
    children?: ReactNode;
    paging?: ReactNode;
  } | null>(null);

  useEffect(() => {
    if (expanded) {
      lastOpenRenderRef.current = { children, paging: childPaging };
    }
  }, [childPaging, children, expanded]);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = expanded;
    if (wasOpen && !expanded) {
      setRetained(lastOpenRenderRef.current);
      // Collapse: if focus is inside the descendant region, move it to the
      // branch toggle before that region becomes inaccessible.
      const toggleElement = toggleRef.current;
      const active = document.activeElement;
      const branch = branchRef.current;
      if (active && branch && branch.contains(active) && active !== toggleElement) {
        toggleElement?.focus();
      }
      // Retain the last open subtree for the exit animation; release it once
      // the shared motion duration plus buffer elapses.
      if (cleanupTimerRef.current !== null) {
        window.clearTimeout(cleanupTimerRef.current);
      }
      cleanupTimerRef.current = window.setTimeout(() => {
        cleanupTimerRef.current = null;
        setRetained(null);
      }, DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS);
      return () => {
        if (cleanupTimerRef.current !== null) {
          window.clearTimeout(cleanupTimerRef.current);
          cleanupTimerRef.current = null;
        }
      };
    }
    if (expanded && cleanupTimerRef.current !== null) {
      // Reopening cancels a pending cleanup; the live subtree renders again.
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
    return undefined;
  }, [expanded]);

  useEffect(
    () => () => {
      if (cleanupTimerRef.current !== null) {
        window.clearTimeout(cleanupTimerRef.current);
        cleanupTimerRef.current = null;
      }
    },
    [],
  );

  const branchControl = hasChildren ? (
    <SidebarThreadBranchControl
      threadId={threadId}
      title={title}
      directChildCount={directChildCount}
      expanded={expanded}
      controlsId={controlsId}
      layout={layout}
      hiddenSummary={hiddenSummary}
      onToggle={onToggle}
      buttonRef={toggleRef}
    />
  ) : (
    <SidebarThreadBranchSlot layout={layout} />
  );
  const renderedChildren = expanded ? children : (retained?.children ?? null);
  const renderedPaging = expanded ? childPaging : (retained?.paging ?? null);

  return (
    <li ref={branchRef} data-thread-branch={threadId} className="w-full min-w-0">
      {renderRow({ branchControl, isHierarchyChild: depth > 0 })}
      {hasChildren ? (
        <DisclosureRegion open={expanded}>
          <ul
            id={controlsId}
            aria-label={`Subagents of ${title}`}
            data-thread-branch-children
            className={cn(
              "m-0 min-w-0 border-l border-sidebar-border p-0",
              CHILD_LIST_PADDING_CLASS[layout],
            )}
            style={{ marginLeft: `${threadLineOffsetPx}px` }}
          >
            {renderedChildren}
            {renderedPaging ? <li>{renderedPaging}</li> : null}
          </ul>
        </DisclosureRegion>
      ) : null}
    </li>
  );
}
