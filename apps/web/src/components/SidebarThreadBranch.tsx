// FILE: SidebarThreadBranch.tsx
// Purpose: Shared orchestrator → subagent/batch branch wrapper used by both sidebars.
// Exports: SidebarThreadHierarchyBranch, hierarchy helpers, and flat-list nesting.
// Depends on: DisclosureRegion/Chevron + disclosureMotion only (220ms ease-out, reduced-motion safe).

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ThreadId } from "@synara/contracts";

import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "../lib/disclosureMotion";
import type { HiddenBranchSummary } from "./sidebarThreadHierarchyPresentation";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { SidebarThreadBranchControl } from "./SidebarThreadBranchControl";

/** Common 12px indent per level, capped at 24px. Logical depth is kept above the cap. */
export const SIDEBAR_HIERARCHY_INDENT_PX = 12;
export const SIDEBAR_HIERARCHY_MAX_INDENT_PX = 24;

export function hierarchyIndentPx(depth: number): number {
  const level = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  return Math.min(level * SIDEBAR_HIERARCHY_INDENT_PX, SIDEBAR_HIERARCHY_MAX_INDENT_PX);
}

const NARROW_VIEWPORT_QUERY = "(max-width: 639px)";

function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(NARROW_VIEWPORT_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const list = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    setNarrow(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * Visual indentation for one branch row. Desktop caps at 24px; below 640px
 * every non-root uses a flat 12px regardless of logical depth. Roots stay 0.
 */
export function useBranchIndentPx(depth: number): number {
  const narrow = useNarrowViewport();
  const level = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  if (level <= 0) {
    return 0;
  }
  if (narrow) {
    return SIDEBAR_HIERARCHY_INDENT_PX;
  }
  return hierarchyIndentPx(level);
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

export interface SidebarThreadHierarchyBranchRenderSlot {
  /** Shared numeric toggle; non-null exactly when directChildCount > 0. */
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
    onToggle,
    renderRow,
    surface = "sidebar",
    threadId,
    title,
  } = props;
  const hasChildren = directChildCount > 0;
  const controlsId = branchControlsId(threadId, surface);
  const indentPx = useBranchIndentPx(depth);
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
      hiddenSummary={hiddenSummary}
      onToggle={onToggle}
      buttonRef={toggleRef}
    />
  ) : null;
  const renderedChildren = expanded ? children : (retained?.children ?? null);
  const renderedPaging = expanded ? childPaging : (retained?.paging ?? null);

  return (
    <li ref={branchRef} data-thread-branch={threadId} className="w-full min-w-0">
      <div className="w-full min-w-0" style={{ paddingLeft: `${indentPx}px` }}>
        {renderRow({ branchControl, isHierarchyChild: depth > 0 })}
      </div>
      {hasChildren ? (
        <DisclosureRegion open={expanded}>
          <ul
            id={controlsId}
            aria-label={`Subagents of ${title}`}
            className="m-0 w-full min-w-0 p-0"
          >
            {renderedChildren}
            {renderedPaging ? <li>{renderedPaging}</li> : null}
          </ul>
        </DisclosureRegion>
      ) : null}
    </li>
  );
}
