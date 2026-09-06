// FILE: SidebarThreadBranch.tsx
// Purpose: Shared orchestrator → subagent/batch branch wrapper used by both sidebars.
// Exports: SidebarThreadHierarchyBranch, hierarchy helpers, and flat-list nesting.
// Depends on: DisclosureRegion/Chevron + disclosureMotion only (220ms ease-out, reduced-motion safe).

import { useEffect, useRef, type ReactNode } from "react";

import type { ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";

import type { ThreadHierarchyEdgeKind } from "./sidebarThreadHierarchy";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { cn } from "../lib/utils";

/** Common 12px indent per level, capped at 48px. Logical depth is kept above the cap. */
export const SIDEBAR_HIERARCHY_INDENT_PX = 12;
export const SIDEBAR_HIERARCHY_MAX_INDENT_PX = 48;

export function hierarchyIndentPx(depth: number): number {
  const level = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  return Math.min(level * SIDEBAR_HIERARCHY_INDENT_PX, SIDEBAR_HIERARCHY_MAX_INDENT_PX);
}

export function formatSubagentCounter(count: number): string {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `${total} ${pluralize(total, "subagent", "subagents")}`;
}

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

export function SidebarThreadHierarchyBranch(props: {
  threadId: ThreadId;
  title: string;
  depth: number;
  directChildCount: number;
  edgeKind?: ThreadHierarchyEdgeKind | undefined;
  expanded: boolean;
  onToggle: (threadId: ThreadId) => void;
  row: ReactNode;
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
    threadId,
    title,
    depth,
    directChildCount,
    edgeKind,
    expanded,
    onToggle,
    row,
    children,
    childPaging,
    surface = "sidebar",
  } = props;
  const hasChildren = directChildCount > 0;
  const controlsId = branchControlsId(threadId, surface);
  const counterText = formatSubagentCounter(directChildCount);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const branchRef = useRef<HTMLLIElement | null>(null);
  const wasOpenRef = useRef(expanded);
  const isBatchEdge = edgeKind === "batch";

  // If collapsing a branch that contains focus, return focus to the toggle so
  // keyboard users are not stranded on an inert node.
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = expanded;
    if (wasOpen && !expanded) {
      const active = document.activeElement;
      const branch = branchRef.current;
      if (active && branch && branch.contains(active) && active !== toggleRef.current) {
        toggleRef.current?.focus();
      }
    }
  }, [expanded]);

  return (
    <li ref={branchRef} data-thread-branch={threadId} className="w-full min-w-0">
      <div
        className="flex min-w-0 items-center gap-1"
        style={{ paddingLeft: `${hierarchyIndentPx(depth)}px` }}
      >
        {hasChildren ? (
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={expanded}
            aria-controls={controlsId}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${counterText} for ${title}`}
            data-thread-selection-safe
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggle(threadId);
            }}
            onKeyDown={(event) => {
              // Native button already activates on Enter/Space; stop the row
              // from also treating the key as navigation.
              event.stopPropagation();
            }}
            className="inline-flex h-5 max-w-full shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 text-[length:var(--app-font-size-ui,11px)] text-muted-foreground/79 hover:bg-transparent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 active:bg-transparent active:text-foreground"
          >
            <DisclosureChevron open={expanded} className="size-3" />
            <span className="truncate tabular-nums">{counterText}</span>
          </button>
        ) : null}
        {isBatchEdge && depth > 0 ? (
          <span
            title="Created as a batch via synara_create_threads"
            className="inline-flex h-4 shrink-0 items-center rounded-full border border-border/50 px-1.5 text-[10px] font-medium leading-none text-muted-foreground/79"
          >
            batch
          </span>
        ) : null}
        <div className="min-w-0 flex-1">{row}</div>
      </div>
      {hasChildren ? (
        <DisclosureRegion open={expanded}>
          <ul id={controlsId} aria-label={`Subagents of ${title}`} className="w-full min-w-0">
            {children}
          </ul>
          {childPaging}
        </DisclosureRegion>
      ) : null}
    </li>
  );
}
