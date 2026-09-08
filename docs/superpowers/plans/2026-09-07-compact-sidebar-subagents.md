# Compact Sidebar Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox syntax for tracking. This is a sequential implementation assignment; do not dispatch additional agents unless separately authorized. Read this entire document before editing.

**Goal:** Replace the wide subagent gutter and full-height child cards with compact inline branch controls and single-line children across every sidebar surface.

**Architecture:** Keep the existing frontend hierarchy index, family ownership, and sidebar state owner. Separate branch controls from branch layout, use one compact child-row component in classic and Activity views, and derive hidden-descendant status from the same visible-row projection used for navigation. Change no backend or protocol contracts.

**Tech Stack:** React 19, TypeScript, Tailwind, existing sidebar state helpers, Vitest, Vitest Browser with Playwright.

**Spec:** The normative specification in sections 1–5 of this file. It incorporates the user's accepted compact design and resolves the remaining implementation details. No external conversation is needed to implement it.

**Handoff status:** Plan only. No implementation steps or application checks have been performed by authoring this document.

## Global constraints

- Performance first. Reliability first. Predictable behavior during streaming, reconnects, and partial snapshots.
- Use `apps/web/src/lib/disclosureMotion.ts` through `DisclosureRegion` and `DisclosureChevron`: 220ms `ease-out`, with the existing reduced-motion behavior.
- Keep `packages/contracts` schema-only. This task makes no changes there.
- Do not add dependencies, new settings, virtualized lists, popup child navigators, or a second hierarchy algorithm.
- Do not re-export types or interfaces from other modules. Import each type directly from its defining file.
- Do not use provider activity, elapsed time, unread changes, or `updatedAt` to open/close branches, change child page size, or reorder siblings.
- Preserve root-family sorting, section placement, pins, archive behavior, filter eligibility, and root-list pagination. This task changes ordering within a family only.
- `bun fmt`, `bun lint`, and `bun typecheck` must pass before automatic integration of the implementation. Bundle these into one final verification pass after focused tests.
- NEVER run `bun test`. Always use `bun run test`.
- Implementation destination is local `nacho/integration`. No push, PR, or deployment is included.

---

## 1. Exact source baseline and handoff

The hierarchy shown in the screenshot is implemented by:

- Branch: `synara/sidebar-activity-hierarchy-final`.
- Required commit: `e5dbab115ee11e7618d1c140db2986e373c5e94d`.
- Its preceding hierarchy commits: `2f2a7ba9f` and `3c7001f9f`.
- Reference checkout inspected: `/Users/usuario/.synara-prod/worktrees/340fa45b7feb`.
- Local integration baseline observed while writing this plan: `c7315d18fab52f9d94c9b8997f41a74f511dce9c`.

The reference checkout has unrelated uncommitted changes. Use the committed revision above, not a recursive copy of that checkout. The hierarchy helper's uncommitted changes inspected during planning were formatting changes; the plan targets committed interfaces.

`SidebarThreadBranch.tsx` currently renders a full `N subagents` button and the `batch` chip as siblings before `row`. This causes the width loss. `SidebarActivityView.tsx` supplies the normal two-line `ActivityThreadRow` for descendants, which causes the height loss. Classic rendering also determines compactness from `parentThreadId`, missing batch children identified by `sourceThreadId`.

Before implementation, create an isolated worktree from the latest local target following `AGENTS.md`. If the required commit is not already an ancestor, merge that exact commit inside the implementation worktree. Do not reimplement the missing foundation against `c7315d18f`.

```sh
git merge-base --is-ancestor e5dbab115ee11e7618d1c140db2986e373c5e94d HEAD
# Exit 0: dependency already present. Exit 1: run the following merge.
git merge --no-edit e5dbab115ee11e7618d1c140db2986e373c5e94d
```

If the commit is missing from the object database, fetch `nacho` and resolve `nacho/synara/sidebar-activity-hierarchy-final`; verify that it contains the required commit before merging. If neither can be obtained, stop with a missing-dependency report. Never copy uncommitted files from another task.

## 2. Normative visual specification

### 2.1 Activity roots, including Activity → Pinned

Keep the existing two-line root row. Keep the provider/title line at its current full width. Put the branch toggle after the project label in the second line:

```text
Collapsed
◉ Proyecto de ingresos automáticos…
  Synara · ▸ 1                         1:53

Expanded
◉ Proyecto de ingresos automáticos…
  Synara · ▾ 1                         1:53
    └ Bot BTC/EUR — continuación…
```

- Visible toggle text is the direct child count only: `1`, `5`, `20`, `99+`.
- Counts above 99 display `99+`; the accessible label and tooltip always contain the exact number.
- Use the existing `DisclosureChevron`, 12px icon, and tabular numerals.
- Do not display `subagent`, `agent`, or `batch` as an extra visible label.
- Do not add a third line to a root row.
- The project label remains visible and truncates before the branch control does. Use `min-w-0` on the project container and `shrink-0` on the control.
- Preserve existing root PR, branch, own status, time, pin, archive, and settle affordances. Place the group toggle before the existing right metadata cluster; do not replace the parent's own status with descendant status.
- At constrained widths, truncate the project and branch text. Keep control and status hit areas. The title must not gain a branch-control reserve because its control is on line two.

### 2.2 Classic roots: Projects, Chats, Studio, and Pinned

Keep the existing single-line root row. Place the same numeric toggle in the trailing flex area after the flexible title and before existing metadata/status/actions. Its width is paid once within that row. Do not create a leading column, a second line, or placeholder space on roots without children.

The Activity title-width guarantee applies to its two-line layout. Classic roots necessarily give the trailing control its actual inline width; this is preferable to the current full-label gutter. Do not conceal this tradeoff with overlap or absolute positioning over the title.

### 2.3 All descendants

Render every row with logical hierarchy depth greater than zero using the same `SidebarCompactChildRow`, including source/batch children with `parentThreadId === null`.

- One visual line. Desktop height: 28px at default font size, with a minimum-height rule rather than fixed clipping. Coarse pointer minimum height: 44px.
- One flexible identity label; native subagents retain the existing nickname/role presentation. Batch children use their actual thread title.
- No project name, timestamp, branch chip, PR chip, provider avatar, or origin badge in the compact row. Their existing hover/detail views remain available.
- Keep current relevant thread status, unread completion marker, selection, rename, context menu, keyboard activation, and applicable pin/archive/settle actions. Root actions retain their existing semantics.
- Do not introduce a new live elapsed-time counter into compact children. Their trailing status glyph is sufficient; the elapsed/detailed metadata remains in existing detail surfaces.
- A child that itself has children gets the same numeric toggle at the end of its line, before its status and action controls.
- Selection uses existing sidebar active/selected tokens. Only the actual active thread receives active-row semantics.
- Hide hover actions only visually at rest; reveal them on both hover and `focus-within`. A coarse pointer must have an explicit action affordance, not a hover-only dependency.

### 2.4 Indentation and connector ownership

Keep logical depth and nested lists. Cap visual indentation to avoid consuming the sidebar at deep nesting:

```ts
export const SIDEBAR_HIERARCHY_INDENT_PX = 12;
export const SIDEBAR_HIERARCHY_MAX_INDENT_PX = 24;

export function hierarchyIndentPx(depth: number): number {
  const level = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  return Math.min(level * SIDEBAR_HIERARCHY_INDENT_PX, SIDEBAR_HIERARCHY_MAX_INDENT_PX);
}
```

- On viewports below 640px, every non-root uses 12px visual indentation, regardless of logical depth.
- Apply indentation on the current branch row wrapper only. Child `<ul>` containers have zero padding/margin; do not accumulate indentation through nested lists.
- `SidebarCompactChildRow` owns the subtle connector using `bg-border/35`; `SidebarThreadRowContent` must not draw a second connector when embedded there.
- Use existing title/role colors, UI font variables, row hover/focus/active tokens, and border color. Do not invent a new colored card surface.

## 3. Normative behavior and state

### 3.1 Family semantics

Preserve `buildThreadHierarchyIndex` link rules: `parentThreadId` wins, otherwise `sourceThreadId`; same-project links only; `gatewayOperationId` alone creates no parent; forks/sidechats remain independent. Preserve orphan, cycle, duplicate, and archive handling.

The numeric counter counts direct available children before collapse/pagination. Grandchildren count on their own parent. Never compute this count from `node.children.length`, because that is the visible slice.

Root families still render once when any family member is pinned. A pinned child remains compact underneath its family root. Do not copy that child into another section or change which thread is actually pinned.

### 3.2 Opening and closing

| Event                                               | Required result                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| First visit, no stored expansion, root active       | Every branch starts closed.                                                                          |
| First visit/restoration with a child active         | Reveal its ancestor path and its position in each child list.                                        |
| Click/Enter/Space on toggle                         | Toggle only that branch; never navigate, rename, select a range, or trigger row actions.             |
| One child                                           | Same behavior and toggle as 5 or 20 children.                                                        |
| Status/time/unread update                           | No expansion or page-state mutation.                                                                 |
| Navigate explicitly to hidden child                 | Open ancestors, retain sibling order, enlarge the visible prefix through the child.                  |
| Manually close a branch containing the active child | Keep it closed. Mark its toggle as containing the current conversation. Do not navigate away.        |
| Subsequent new navigation to a descendant           | Reveal again, even if the previous active child had been manually hidden.                            |
| Switch classic/Activity/Studio                      | Reuse expansion/page state; do not reset it.                                                         |
| Reload                                              | Restore explicit expanded IDs. Child visible limits reset to five; restored active path is revealed. |
| Storage denied/corrupt                              | Keep functional in-memory state and existing safe fallback behavior.                                 |

Persist expansion in the existing `expandedThreadIds` field under `synara:sidebar-ui:v1`. Do not create a second localStorage key. Navigation that opens ancestors records them in `expandedThreadIds`; this ensures navigating away does not unexpectedly collapse the previous family. Existing external-storage synchronization must adopt the same field.

Keep `collapsedThreadIds` as the existing in-memory override for the current navigation. Clear it only on new navigation, not on thread updates. Clicking an already active thread through an explicit navigation action also counts as new navigation; process that action in the activation wrapper rather than relying solely on active-ID changes.

### 3.3 Ordering and pagination

- Root sorting is unchanged.
- Sort direct siblings by `createdAt` ascending, then ID ascending using code-unit comparison (`a < b`, not locale-dependent collation).
- Missing/invalid creation time sorts as epoch zero, with ID resolving ties. `updatedAt`, title, status, and provider never participate in sibling ordering.
- Initial visible prefix: five direct children. With 0–5 children there is no paging row.
- With 20 children: render 1–5 and `Show 15 more`. Clicking it reveals all remaining direct children. This label states exactly what the click does.
- Once expanded beyond the first five, show `Show less`. It resets the visible prefix to `max(5, active-direct-child-position + 1)`, capped to total; it cannot hide the active descendant path.
- Explicit navigation to child 17 renders the prefix 1–17, not 1–5 plus 17, and does not reorder 17 to the front.
- A prefix enlarged by navigation remains that large until an explicit `Show less`, branch close, or remount. Navigating elsewhere does not shrink the list.
- Closing a branch clears that parent's in-memory limit. Reopening starts at five, enlarged if needed for the still-active descendant. Descendant preferences are not recursively erased.
- When a new child arrives, existing visible rows keep their order and the limit does not increase. Update the counter and hidden count. Actual additions/removals may naturally change geometry; status-only updates may not.
- Page by direct children; expanded grandchildren do not consume their parent's five slots.

Replace the existing extra-page state with `childVisibleCountByParentId: ReadonlyMap<ThreadId, number>`. It is mount-local, shared across surfaces, and never serialized. A requested count is a non-negative integer; default is five, actual count clamps to available children.

### 3.4 Hidden descendant status

Compute one summary for each visible branch from descendants that are not represented by visible thread rows in that surface. Use the existing thread-status resolver; do not infer status from transcript text or polling.

Assign each hidden descendant to its nearest visible ancestor. This prevents counting a hidden grandchild on both the root and an already visible child. Exclude the ancestor's own status, invalid hierarchy nodes, and archived/filtered nodes.

| Hidden status                                         | Classification    |
| ----------------------------------------------------- | ----------------- |
| `Pending Approval`, `Awaiting Input`, `Plan Ready`    | Attention         |
| `Working`, `Connecting`                               | Running           |
| `Completed` after existing visibility/dismissal rules | Unread completion |
| `null`                                                | No status         |

Presentation priority: attention > running > unread > no glyph. Attention uses `TriangleAlertIcon` plus its count; running uses the existing small spinner without a count; unread uses `SidebarUnreadCompletionGlyph`. Attention counts above 99 display `99+`; accessibility retains the exact count. Keep one aggregate glyph, not three concurrent badges.

The aggregate sits next to the numeric branch counter. Parent own status remains in its own slot. When every descendant is visible, omit the aggregate. A hidden active child highlights the toggle using existing accent text; it does not mark the parent row `aria-current`.

The button's accessible label includes action, exact direct count, parent title, hidden status counts, and whether it contains the current conversation. Use a tooltip for the same summary on hover/focus. Do not add a full list of children to the hover card in this task.

## 4. Component and data contracts

All paths below are relative to the implementation worktree.

| File                                                                  | Responsibility                                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/sidebarThreadHierarchy.ts`                   | Existing links/index; deterministic child order; visible prefix helpers.                                  |
| `apps/web/src/components/sidebarThreadHierarchyPresentation.ts` — new | Pure hidden-state aggregation and explicit-navigation reveal plan.                                        |
| `apps/web/src/components/SidebarThreadBranch.tsx`                     | Shared list/indent/disclosure shell; supplies a control through a render slot; no leading controls/chips. |
| `apps/web/src/components/SidebarThreadBranchControl.tsx` — new        | Numeric toggle, summary glyph/tooltip, keyboard and pointer behavior.                                     |
| `apps/web/src/components/SidebarThreadBranchPaging.tsx` — new         | Shared `Show N more` / `Show less` actions.                                                               |
| `apps/web/src/components/SidebarCompactChildRow.tsx` — new            | Single descendant-row layout and existing actions/gestures.                                               |
| `apps/web/src/components/SidebarThreadRowContent.tsx`                 | Existing identity labels, with explicit compact-child/connector options.                                  |
| `apps/web/src/components/Sidebar.logic.ts`                            | Visible tree projection passes the new visible-count state and retains all downstream metadata.           |
| `apps/web/src/components/Sidebar.tsx`                                 | Shared expansion/count state, navigation reveal, classic/Chats/Studio/Pinned adapters.                    |
| `apps/web/src/components/SidebarActivityView.tsx`                     | Two-line root control placement, compact descendant adapter, Activity visibility summary.                 |
| `apps/web/src/components/SidebarActivityView.logic.ts`                | Uses the same child ordering and visible-count contracts; preserves family sorting.                       |
| `apps/web/src/components/Sidebar.uiState.ts`                          | Existing expansion persistence; remove obsolete extra-page helper if no longer used.                      |

No new generic tree package, new store, or provider-specific component is required.

### 4.1 Pure presentation contracts

Create these exports in `sidebarThreadHierarchyPresentation.ts`. Import the types from their original files.

```ts
import type { ThreadId } from "@synara/contracts";
import type { SidebarThreadSummary } from "../types";
import type { ThreadStatusPill } from "./Sidebar.logic";
import type { ThreadHierarchyIndex } from "./sidebarThreadHierarchy";

export interface HiddenBranchSummary {
  hiddenCount: number;
  attentionCount: number;
  runningCount: number;
  unreadCount: number;
  containsActiveThread: boolean;
}

export interface HierarchyRevealPlan {
  ancestorIds: readonly ThreadId[];
  minimumVisibleCountByParentId: ReadonlyMap<ThreadId, number>;
}

export function buildHiddenBranchSummaries(input: {
  index: ThreadHierarchyIndex<SidebarThreadSummary>;
  visibleThreadIds: ReadonlySet<ThreadId>;
  statusByThreadId: ReadonlyMap<ThreadId, ThreadStatusPill | null>;
  activeThreadId: ThreadId | null;
}): ReadonlyMap<ThreadId, HiddenBranchSummary>;

export function buildHierarchyRevealPlan(input: {
  index: ThreadHierarchyIndex<SidebarThreadSummary>;
  threadId: ThreadId;
}): HierarchyRevealPlan;
```

`buildHiddenBranchSummaries` performs one iterative forest traversal carrying the nearest visible ancestor. A visible node becomes the owner for the following hidden descendants. A hidden node increments its owner's summary, then keeps passing that owner. Roots with no visible owner produce no summary. Initialize summaries only for visible nodes with direct children. Complexity is O(n); do not walk every ancestor for every node.

`buildHierarchyRevealPlan` walks the validated parent chain. For each `(parent, child-on-path)` pair, record the child's zero-based position plus one in the parent's already sorted child array. Return nearest-parent-first `ancestorIds`. Return empty outputs for hidden/unknown nodes. Do not modify expansion or index data.

### 4.2 Branch render slot

Replace `row: ReactNode` in `SidebarThreadHierarchyBranch` with:

```ts
renderRow: (slot: {
  branchControl: ReactNode;
  isHierarchyChild: boolean;
}) => ReactNode;
hiddenSummary?: HiddenBranchSummary;
```

Keep `threadId`, `title`, `depth`, `directChildCount`, `expanded`, `onToggle`, `children`, `childPaging`, and `surface`. Remove the visual use of `edgeKind`; retain edge kind in model rows because other logic uses it.

The shell constructs the shared control only when `directChildCount > 0`, and calls `renderRow` with it. It renders no control before or outside the row. Preserve surface-qualified `branchControlsId` and focus restoration. `branchControl` is a native button and must never be nested inside another button, link, or `role="button"` navigation container.

### 4.3 Compact row contract

```ts
export interface SidebarCompactChildRowProps {
  thread: SidebarThreadSummary;
  surface: string;
  isActive: boolean;
  isSelected: boolean;
  status: ThreadStatusPill | null;
  branchControl: ReactNode;
  threadJumpLabel: string | null;
  onActivate: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPrime: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onRename: (threadId: ThreadId) => void;
  onRenamePointerUp: (event: React.PointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onContextMenu: (threadId: ThreadId, position: SidebarRowContextMenuPosition) => void;
  renderHoverCard: (anchorId: string) => ReactNode;
  actions: ReactNode;
}
```

Use type-only named React imports when writing the actual file. The navigation button, branch control, status, shortcut, and actions are siblings inside a non-interactive visual wrapper. Use `createSidebarThreadRowGestures` on that wrapper, guarded against branch/paging/action targets so double-click does not rename from those controls. Reuse the existing activation/selection callbacks from each surface instead of duplicating navigation logic.

`actions` contains the surface's existing applicable controls. Activity supplies pin/archive/settle; classic supplies its existing action cluster. Do not implement a second archive/pin handler in this component.

## 5. Accessibility, interaction, and motion details

- Toggle: `type="button"`, `aria-expanded`, `aria-controls`, descriptive `aria-label`, `data-thread-selection-safe`.
- `onClick`: prevent default, stop propagation, toggle exactly once. Stop propagation for pointer-down, key-down, double-click, and context-menu on the control so wrapper gestures do not fire. Do not prevent the native Enter/Space activation behavior.
- Keyboard target is at least 24×24px on fine pointers; coarse-pointer target is at least 44×44px. The icon remains 12px. Touch row height may increase to satisfy the target; do not overlay invisible hit regions over neighboring controls.
- Use ordinary nested list semantics, not `role="tree"`; no incomplete tree keyboard model.
- Top-level family lists must be `<ul>` or `<ol>`. In particular, replace the classic Pinned `<div>` list container that currently receives branch `<li>` elements.
- Only actual visible thread rows carry navigation/shortcut IDs. Toggle, paging, and exit-animation remnants are never navigation targets.
- On collapse, if focus is inside the descendant region, move focus to the branch toggle before that region becomes inaccessible.
- Render the subtree through `DisclosureRegion`. Closed regions are immediately `aria-hidden` and `inert`.
- Retain only the last open rendered subtree during the 220ms closing animation, then discard it after `DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS`. Cancel cleanup on reopening/unmount. Never retain every unopened branch or subscribe to hidden descendants to animate them.
- Keep retained visual nodes separate from live `visibleThreadIds` immediately on collapse. Do not derive visible navigation from DOM queries.
- No changes to chat transcript scrolling, virtualizer measurement, or bottom-stick logic.

---

## Task 0: Prepare the exact implementation base

**Files:** Repository/worktree setup only.

- [ ] Read the destination's `AGENTS.md`, `frontend-rules`, `git-paraty`, `web-tests`, and `react-doctor` instructions. Preserve the user's standing local-workflow permissions.
- [ ] Inspect status/worktrees, record target branch, initial commit, and worktree path. Use a new `feature/compact-sidebar-subagents` branch from local `nacho/integration`; do not develop on the target or in another agent's worktree.
- [ ] Incorporate available target upstream advances with merge, then establish the required dependency from section 1. Resolve dependency conflicts inside the worktree; preserve the compact behavior specified here if presentation code has advanced.
- [ ] Prepare Bun dependencies with the committed lockfile. Record focused baseline test outcomes before changing code. Do not start the full Synara application merely to run component tests.
- [ ] Record a baseline React Doctor score and diagnostics with `npx react-doctor@latest --verbose --scope changed` before editing React files; compare the final run against that recorded baseline and the task diff.

```sh
bun install --frozen-lockfile
cd apps/web
bun run test src/components/sidebarThreadHierarchy.test.ts src/components/Sidebar.logic.test.ts src/components/Sidebar.uiState.test.ts src/components/SidebarActivityView.logic.test.ts
```

**Deliverable:** Isolated checkout containing the required hierarchy and a recorded baseline. If baseline tests fail, distinguish those failures from new failures; do not claim a passing final validation until resolved.

## Task 1: Deterministic ordering and visible-prefix pagination

**Modify:** `sidebarThreadHierarchy.ts`, `Sidebar.logic.ts`, `SidebarActivityView.logic.ts`.

**Tests:** `sidebarThreadHierarchy.test.ts`, `Sidebar.logic.test.ts`, `SidebarActivityView.logic.test.ts`.

**Consumes:** Existing validated hierarchy and root ordering.

**Produces:** Five-child initial prefixes, creation-ordered children, `childVisibleCountByParentId` inputs, correct actual hidden IDs.

- [ ] Add failing tests for the cases in the table below before replacing pagination.
- [ ] Add optional `createdAt?: string | undefined` to `ThreadHierarchyNode` and the generic tree input constraint. Precompute parsed creation times once per node. Sort only each direct-child ID array; leave `rootIds` unchanged.
- [ ] Replace `SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE` with `SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT = 5`. Replace extra-page inputs/outputs with explicit count inputs/outputs. Keep helper names `resolveThreadChildPage` and `resolveVisibleChildThreadIds` so callers remain easy to locate.
- [ ] Implement prefix computation using the following exact algorithm; `requestedVisibleCount` defaults to five and malformed values normalize to five.

```ts
const initialCount = SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT;
const requestedCount = Number.isFinite(input.requestedVisibleCount)
  ? Math.max(initialCount, Math.floor(input.requestedVisibleCount ?? initialCount))
  : initialCount;
let requiredCount = 0;
for (let position = 0; position < childIds.length; position += 1) {
  const childId = childIds[position];
  if (childId !== undefined && input.revealedThreadIds?.has(childId)) {
    requiredCount = position + 1;
  }
}
const visibleCount = Math.min(childIds.length, Math.max(requestedCount, requiredCount));
const visibleChildIds = childIds.slice(0, visibleCount);
const hiddenChildIds = childIds.slice(visibleCount);
const hasMoreChildren = hiddenChildIds.length > 0;
const hasLessChildren =
  visibleCount > Math.min(childIds.length, Math.max(initialCount, requiredCount));
```

- [ ] `resolveThreadChildPage` returns `{ visibleCount, hasMoreChildren, hasLessChildren }`; accept `totalChildCount`, `requestedVisibleCount?`, and `minimumVisibleCount?` to share this math with the ID resolver. Normalize non-finite total/minimum values to zero; floor and clamp finite values to zero or greater. `VisibleThreadChildren` keeps actual ID arrays, total, and the two booleans; remove `effectiveExtraPages`.
- [ ] Rename `childExtraPagesByParentId` to `childVisibleCountByParentId` in `buildProjectThreadTree`, Activity visible-ID projection, and all their callers/tests. Pass `requestedVisibleCount` from the map. Keep `forceVisibleThreadId` as the immediate render-time active-path fallback, with `collapsedThreadIds` retaining precedence.
- [ ] Preserve index and tree row edge metadata, root IDs, direct counts, and iterative traversal. Remove old comments promising 20-child pages or input-order sibling sorting.

| Test input                                    | Exact expected outcome                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| 0 / 1 / 5 children                            | 0 / 1 / 5 visible; no more/less action.                                                 |
| 20 children, default request                  | IDs 1–5 visible; 6–20 hidden.                                                           |
| 20 children, request 20                       | All visible; less available.                                                            |
| 20 children, reveal ID 17                     | IDs 1–17 visible; 18–20 hidden.                                                         |
| Request 500, 3 children                       | Exactly 3 visible.                                                                      |
| Request NaN, negative, fractional             | Safe integer count; never below initial five when total permits.                        |
| Input order reversed, distinct creation times | Child order remains creation order; root order follows input.                           |
| Equal/invalid creation times                  | ID tie-break is deterministic.                                                          |
| Child status/updatedAt/title changes          | Child order unchanged.                                                                  |
| Active grandchild on third direct-child path  | Root prefix includes that direct child; nested branch independently reveals grandchild. |

Use a minimal structure fixture in pure tests:

```ts
const threads = [
  { id: "root", projectId: "p", createdAt: "2026-09-01T00:00:00Z" },
  ...Array.from({ length: 20 }, (_, index) => ({
    id: `child-${String(index + 1).padStart(2, "0")}`,
    projectId: "p",
    sourceThreadId: "root",
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, index + 1)).toISOString(),
  })),
];
const index = buildThreadHierarchyIndex(threads);
const page = resolveVisibleChildThreadIds({
  index,
  parentId: "root",
  revealedThreadIds: new Set(["child-17"]),
});
expect(page.visibleChildIds).toEqual(threads.slice(1, 18).map((thread) => thread.id));
expect(page.hiddenChildIds).toEqual(["child-18", "child-19", "child-20"]);
```

- [ ] Run the focused pure tests from Task 0. Fix only failures introduced by this task or dependency blockers required for it.

## Task 2: Hidden-state aggregation and navigation reveal

**Create:** `sidebarThreadHierarchyPresentation.ts`, `sidebarThreadHierarchyPresentation.test.ts`.

**Modify:** `Sidebar.tsx`, `Sidebar.uiState.ts`, related state tests.

**Consumes:** Task 1's sorted index and visible prefixes.

**Produces:** Section 4.1 helpers; stable persistent expansion and mount-local visible-count state.

- [ ] Write failing helper tests for all summary/reveal cases in section 7.
- [ ] Implement the two pure helpers with their exact section 4.1 interfaces. Use iterative traversal, existing status labels, and nearest-visible-owner assignment.
- [ ] In `Sidebar.tsx`, replace `childExtraPagesByParentId` state with `childVisibleCountByParentId`. Keep state ownership here; neither child components nor Activity write localStorage independently.
- [ ] Add a memoized hierarchy index over the existing full sidebar-tree summaries after the existing exclusion rules. Do not index the visible/paged flat list for navigation or totals.
- [ ] Add `revealHierarchyThread(threadId)` which obtains the reveal plan, removes its ancestor IDs from `collapsedThreadIds`, unions ancestors into persisted `expandedThreadIds`, and raises each visible count using `Math.max(currentCount ?? 5, requiredCount)`. Update maps/arrays immutably and return existing references when unchanged.
- [ ] Add `activateSidebarHierarchyThread(threadId)` which invokes that reveal function and then the existing `activateThreadFromSidebarIntent(threadId)`. Replace only sidebar navigation callsites, including row activation, Activity `onOpenThread`, search results, next/previous shortcuts, and numeric thread shortcuts. Preserve modifier selection behavior: range/multi-select operations that do not navigate must not reveal unrelated branches.
- [ ] For navigation originating outside the sidebar and restored routes, reveal when `activeSidebarThreadId` changes. If the thread is not yet in the validated index, leave the navigation pending; apply it once when its path becomes available. Track the successfully processed active ID in a ref. Subsequent same-ID snapshot/status changes must not invoke reveal again. Explicit same-ID navigation still invokes the wrapper directly.
- [ ] Replace `showMoreHierarchyChildren` with `(parentId, totalChildCount) => set count to totalChildCount`. Replace `showLessHierarchyChildren` with resetting to five or the current active-path minimum, whichever is greater. Closing a branch deletes that parent's count entry.
- [ ] Keep existing expansion persistence/sanitization/external-storage adoption. Remove `resolveThreadChildExtraPages` only after all its callsites/tests are migrated. Do not serialize the count map.

The navigation count update is exactly:

```ts
setChildVisibleCountByParentId((current) => {
  let next: Map<ThreadId, number> | undefined;
  for (const [parentId, required] of revealPlan.minimumVisibleCountByParentId) {
    const previous = current.get(parentId) ?? SIDEBAR_THREAD_HIERARCHY_INITIAL_CHILD_COUNT;
    if (required <= previous) continue;
    next ??= new Map(current);
    next.set(parentId, required);
  }
  return next ?? current;
});
```

- [ ] Do not perform `localStorage` writes inside React state updater functions. Use the existing centralized persistence effect after state is committed; consolidate the expansion-specific persistence callback into that path if it currently performs updater side effects.
- [ ] Verify that status-only updates produce the same expanded IDs and visible-count values, manual close survives such updates, and explicit navigation reopens correctly.

## Task 3: Inline branch control and shared paging shell

**Create:** `SidebarThreadBranchControl.tsx`, `SidebarThreadBranchPaging.tsx`.

**Modify:** `SidebarThreadBranch.tsx`, `SidebarThreadHierarchy.browser.tsx`.

**Consumes:** `HiddenBranchSummary`, direct count, open state, existing branch control ID.

**Produces:** Section 4.2 render slot and reusable numeric controls with no leading gutter.

- [ ] Update the existing dual-presentation browser harness to pass a render function that places `branchControl` inside its row layout.
- [ ] Add failing tests proving zero root-row horizontal displacement, absence of `batch`, native button semantics, and the same compact control for 1 and 20 children.
- [ ] Extract the toggle into `SidebarThreadBranchControl`. Its props are `threadId`, `title`, `directChildCount`, `expanded`, `controlsId`, `hiddenSummary`, `onToggle`, and `buttonRef`. `buttonRef` is `React.Ref<HTMLButtonElement>` so the branch retains focus ownership.
- [ ] Use the numeric visual label and full accessible label described above. Keep `formatSubagentCounter` for accessible English singular/plural copy; do not render its full result visibly.
- [ ] Remove the `batch` span and the leading toggle from the branch wrapper. Construct the control and supply it through `renderRow`. Set the root row wrapper `w-full min-w-0`; apply only the depth indentation from section 2.4.
- [ ] Add `SidebarThreadBranchPaging` with props `{ hiddenCount, canShowLess, onShowMore, onShowLess }`. Text is exactly `Show ${hiddenCount} more` and `Show less`. Use the same event guards and focus tokens as the branch control. Render paging inside a `<li>` within the branch `<ul>`, not as an invalid direct button child of a list.
- [ ] Preserve shared `DisclosureRegion` and the existing focus-restoration intent. When live children disappear on collapse, retain the last open rendered ReactNode subtree for exit only. Cache it on committed open renders, reuse it only while closed, and release it using the shared motion duration/buffer. Reopening cancels the timer. Retained content must be inert immediately.
- [ ] Update indentation tests to 0/12/24/24 for depths 0/1/2/9, and add the below-640px 12px cap.

The branch layout must have this structure:

```tsx
<li data-thread-branch={threadId} className="w-full min-w-0">
  <div className="w-full min-w-0" style={indentStyle}>
    {renderRow({ branchControl, isHierarchyChild: depth > 0 })}
  </div>
  {directChildCount > 0 ? (
    <DisclosureRegion open={expanded}>
      <ul id={controlsId} aria-label={`Subagents of ${title}`} className="m-0 w-full min-w-0 p-0">
        {renderedChildren}
        {renderedPaging ? <li>{renderedPaging}</li> : null}
      </ul>
    </DisclosureRegion>
  ) : null}
</li>
```

Here `indentStyle`, `renderedChildren`, and `renderedPaging` are the local indentation and retained-or-live content values specified in this task; they are not additional external dependencies.

- [ ] Run `SidebarThreadHierarchy.browser.tsx` with the existing Vitest Browser config and verify actual DOM geometry after motion settles, not a JSX snapshot.

## Task 4: One compact child-row implementation

**Create:** `SidebarCompactChildRow.tsx`, `SidebarCompactChildRow.browser.tsx`.

**Modify:** `SidebarThreadRowContent.tsx`, `SidebarThreadRowContent.browser.tsx`.

**Consumes:** Section 4.3 props, existing sidebar identity/status/actions/gesture helpers.

**Produces:** One child row used by every surface for both hierarchy edge kinds.

- [ ] Add browser cases for a native child with nickname/role and a batch child whose `parentThreadId` is null.
- [ ] Add explicit optional `isHierarchyChild` and `showHierarchyConnector` props to `SidebarThreadRowContent`. Default `isHierarchyChild` to the previous native-child detection for existing callers; default connector to current behavior. The new compact row passes `isHierarchyChild={true}` and `showHierarchyConnector={false}` because it owns the connector.
- [ ] Keep native-label detection separate from compact-layout detection. Only actual native subagents call the subagent nickname presentation. A source/batch child displays `thread.title` without fabricating a parent ID or a `batch` role.
- [ ] Implement the section 4.3 layout with a non-interactive wrapper. Put `SidebarThreadRowContent` inside the native navigation button and place branch control, status, shortcut, and actions as siblings.
- [ ] Use the existing `SidebarStatusTrailingGlyph` and `resolveThreadStatusTrailingIndicator`. Pending/working status must not disappear when hover actions appear; reserve its slot separately. Existing unread suppression for the actually active child still applies.
- [ ] Wire `createSidebarThreadRowGestures`, hover anchor IDs, priming, and callbacks. Use scope-qualified anchors to avoid collisions between mounted surfaces. Put `aria-current="page"` on the actual active navigation button only.
- [ ] Preserve native row drag behavior when the existing surface supports it. Delegate the existing dataTransfer/selection logic through an optional `dragProps` prop typed as `Pick<React.HTMLAttributes<HTMLDivElement>, "draggable" | "onDragStart" | "onDragEnd">`; add it to the component contract. Do not turn source children into independently draggable project/folder roots.
- [ ] Verify one line, required hit targets, ellipsis/truncation, visible focus, separate control activation, and no duplicate connector or provider icon.

```tsx
<div className="group/compact-child relative flex min-h-7 min-w-0 items-center gap-1 rounded-md">
  <button
    type="button"
    onClick={onActivate}
    onPointerDown={onPrime}
    className="flex min-w-0 flex-1 items-center text-left"
    aria-current={isActive ? "page" : undefined}
  >
    <SidebarThreadRowContent
      thread={thread}
      terminalEntryPoint={false}
      terminalStatus={null}
      terminalCount={0}
      isActive={isActive}
      variant="standard"
      isHierarchyChild
      showHierarchyConnector={false}
    />
  </button>
  {branchControl}
  {visibleStatus ? <SidebarStatusTrailingGlyph status={visibleStatus} /> : null}
  {shortcutNode}
  {actions}
</div>
```

Complete this skeleton with the exact existing style tokens, tooltip, connector, gesture, drag, touch, and focus behavior above. `visibleStatus` is the result of the existing status visibility resolver; `shortcutNode` uses the current `Kbd`/`KbdGroup` and `splitShortcutLabel` path, with no shortcut for controls or paging rows.

## Task 5: Wire every surface and a single visible-ID source

**Modify:** `Sidebar.tsx`, `SidebarActivityView.tsx`, `SidebarActivityView.logic.ts`, `Sidebar.logic.ts`.

**Tests:** `SidebarActivityView.browser.tsx`, `SidebarActivityView.logic.test.ts`, `Sidebar.logic.test.ts`, `SidebarThreadHierarchy.browser.tsx`.

**Consumes:** All earlier task outputs.

**Produces:** Identical compact descendants and behavior in all sidebar entry points.

- [ ] Change `renderNestedHierarchyNode` / `renderNestedHierarchyList` and Activity `renderNestedFamilyNode` to supply `renderRow`. Their callbacks receive depth plus the control slot, rather than constructing a complete row before the branch shell can provide the control.
- [ ] Classic: when `isHierarchyChild`, render `SidebarCompactChildRow`; otherwise pass the control into the existing standard/pinned root row's trailing flex cluster. Suppress no root action or metadata. Make root navigation and toggle sibling interactive elements rather than nesting the toggle in existing `role="button"` wrappers.
- [ ] Activity: when `isHierarchyChild`, render the same compact component; otherwise pass `branchControl` into `ActivityThreadRow`. Refactor its existing full-row button into a non-interactive row wrapper with a native title navigation button and a metadata line containing the project navigation button, branch control, and existing right metadata. All actions remain sibling buttons. Background/hover/settled styling belongs to the wrapper, not duplicated cards around each element.
- [ ] Convert the classic Pinned family container to `<ul>`. Preserve all family de-duplication code and per-thread pin actions.
- [ ] Replace both duplicated child-paging render functions with `SidebarThreadBranchPaging`. `hiddenCount` comes from actual direct children minus visible direct children; pass the full direct count to the show-more state callback.
- [ ] Classic: compute hidden summaries against the same tree rows used by that mounted surface's shortcuts and visible-thread collection. Activity: memoize the forest of currently included families, compute live visible rows once, and use those rows both to render/nest and to produce `onVisibleThreadIdsChange`. Do not independently rebuild rendering and reported IDs with different limits.
- [ ] Build `statusByThreadId` for eligible hierarchy nodes using the existing resolved status function followed by `resolveThreadStatusTrailingIndicator({ status, isActive: thread.id === activeSidebarThreadId })`; do not pass hover/shortcut slot suppression to this aggregate input. Then call `buildHiddenBranchSummaries` once per mounted surface projection. Pass each summary to its visible branch. Do not scan every family's descendants inside every row render.
- [ ] Keep root paging/filters/sections authoritative. A summary must not advertise a family excluded by the current scope. Expansion controls and `Show more/less` never enter `visibleThreadIds`.
- [ ] Preserve split-chat active-thread selection from the existing `activeSidebarThreadId`; do not derive active state from the parent/orchestrator or rewrite chat grouping.
- [ ] Verify shortcuts, prewarming, PR refresh targets, and next/previous navigation consume the post-collapse/post-page visible IDs. No hidden or retained-exit row may become a shortcut target.

## Task 6: Regression matrix and visual verification

**Modify:** The tests listed above; add focused test cases rather than broad snapshots.

- [ ] Execute every case in section 7. Each assertion must prove user-observable behavior or a data invariant, not just that a helper duplicates its implementation.
- [ ] Use the current `SidebarActivityView.browser.tsx` `makeThread`/`makeProject` fixtures. Extend fixture inputs with source-child fields as needed. Keep the real source-child `parentThreadId: null` case; otherwise tests would miss the original batch-layout bug.
- [ ] Add root-title geometry comparison with and without children at a 280px sidebar: the Activity root title's left edge and width match within 1px. At 240px width, `scrollWidth <= clientWidth + 1`.
- [ ] Assert compact desktop child height is at most 32px at the default font size and displays exactly one metadata-free line. At increased font size, it grows rather than clipping. For coarse pointers, assert row/control minimum heights are 44px.
- [ ] For stable geometry, use two pinned families in fixed pin order, capture the second family's top coordinate, update only a first-family child's Working/Completed/Attention status, and assert the coordinate remains within 1px. Run against both a closed group and an open group. Activity's existing relocation between status sections is outside this geometry assertion and must remain functional; the guarantee concerns branch size/ordering, not freezing the existing root feed.
- [ ] Use browser keyboard events for Tab, Enter, Space, and focus restoration. Assert the navigation callback count stays zero when toggling/paging and increments exactly once when activating a child.
- [ ] Inspect screenshots in dark and light themes with 1, 5, and 20 children, long titles, selected child, hidden attention, and 240/280/360px containers. Include a 390×844 coarse-pointer viewport and reduced-motion mode. Store evidence outside tracked source or as task artifacts, not as unrelated repository assets.
- [ ] Run a `react-doctor` check after React changes and fix new regressions before commit. Apply its current skill instructions.

Run unit tests from `apps/web`:

```sh
bun run test src/components/sidebarThreadHierarchy.test.ts src/components/sidebarThreadHierarchyPresentation.test.ts src/components/Sidebar.logic.test.ts src/components/Sidebar.uiState.test.ts src/components/SidebarActivityView.logic.test.ts
```

Before the component browser tests, check the dedicated harness port:

```sh
lsof -nP -iTCP:51137 -sTCP:LISTEN
```

If occupied, use the first free port in 51138–51147 and pass it through the same environment variable. The component harness does not need a Synara server or production credentials.

```sh
env VITEST_BROWSER_API_PORT=51137 bun run test:browser src/components/SidebarThreadHierarchy.browser.tsx src/components/SidebarCompactChildRow.browser.tsx src/components/SidebarThreadRowContent.browser.tsx src/components/SidebarActivityView.browser.tsx
npx react-doctor@latest --verbose --scope changed
```

Confirm the expected test files actually ran; a zero-test success is not validation. Do not run application-wide tests merely to compensate for missing assertions in these files.

## 7. Mandatory acceptance cases

| ID  | Scenario                                                              | Required assertion                                                                   |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A01 | Root with no children                                                 | No control, gutter, spacer, or new line.                                             |
| A02 | Root with one child                                                   | Numeric toggle; initially closed unless active descendant is restored.               |
| A03 | Open one native child                                                 | Single compact row; nickname/role preserved.                                         |
| A04 | Open one source/batch child with null parentThreadId                  | Same compact row; full title; no `batch` badge.                                      |
| A05 | Five children                                                         | Exactly five rows; no paging.                                                        |
| A06 | Twenty children                                                       | Initial five; `Show 15 more` reveals all twenty.                                     |
| A07 | Twenty children, activate seventeenth                                 | Prefix 1–17; remaining count three; selection visible.                               |
| A08 | Navigate from seventeenth to another family                           | Previous family's open state and prefix stay unchanged.                              |
| A09 | Close active child's parent then receive a status update              | Remains closed; toggle indicates hidden current conversation.                        |
| A10 | New navigation to a hidden child                                      | Ancestors reopen; manual-close suppression cleared for that intent.                  |
| A11 | Status/updatedAt changes with unchanged membership                    | No sibling reorder, expansion change, or page mutation.                              |
| A12 | CreatedAt ties and reversed snapshot input                            | Deterministic ID order among siblings.                                               |
| A13 | Hidden approval and running descendants                               | One attention aggregate with exact attention count; root own status unaffected.      |
| A14 | Only hidden running descendants                                       | One running aggregate without running count.                                         |
| A15 | Only hidden unread completion                                         | Existing unread completion glyph.                                                    |
| A16 | Visible parent → visible child → hidden grandchild awaiting input     | Grandchild counted on visible child, not duplicated on root.                         |
| A17 | All descendants visible                                               | No hidden aggregate; per-row status remains.                                         |
| A18 | Pin a child then switch surfaces                                      | Family appears once in Pinned; child stays compact; actual pin identity preserved.   |
| A19 | Collapse or page a family                                             | Rendered live thread IDs exactly equal reported navigation IDs in the same order.    |
| A20 | Focus inside a collapsing branch                                      | Focus returns to toggle; descendants inert and excluded from navigation immediately. |
| A21 | Enter/Space/click/double-click on toggle                              | One toggle; no navigation, rename, context menu, or selection side effect.           |
| A22 | Long title, 240px container, deep nesting                             | No horizontal overflow; indentation capped; title truncates.                         |
| A23 | Coarse pointer and keyboard                                           | Controls reachable with required hit sizes and visible focus.                        |
| A24 | Reload, corrupt storage, external storage update                      | Existing safe fallback/sync; expansion shared; count map not serialized.             |
| A25 | Parent missing initially then valid snapshot arrives for active child | Reveal once after hydration; later status updates do not reopen a manual collapse.   |
| A26 | Parent has 0 eligible children after archival                         | Counter/control disappear; no orphan promotion or stale aggregate.                   |
| A27 | Cycles, cross-project edges, self-parent, duplicate IDs               | Existing exclusion semantics preserved; no unbounded traversal.                      |
| A28 | Activity project/date grouping and Done/Pinned sections               | Existing family eligibility and root pagination preserved.                           |
| A29 | Classic Projects/Chats/Studio/Pinned                                  | All use shared compact row and trailing root toggle; no leading counter gutter.      |
| A30 | Reduced motion and rapid open/close/reopen                            | Shared motion fallback; cleanup cancelled correctly; no focus loss or stale rows.    |

For helper-level A13–A17 tests, construct a tree with root `r`, visible child `a`, hidden sibling `b`, and hidden grandchild `a1`. With visible IDs `{r,a}`, `b` Working and `a1` Awaiting Input: root summary is runningCount=1/attentionCount=0; `a` summary is attentionCount=1/runningCount=0. Closing `r` changes visible IDs to `{r}`: root summary has hiddenCount=3, runningCount=1, attentionCount=1, and no summary for `a`.

## Task 7: Review, final checks, and local integration

**Files:** Task diff and feature documentation only.

- [ ] Update/create `docs/features/compact-sidebar-subagents.md` describing numeric controls, fixed initial prefix, explicit reveal behavior, and descendant status. Link to this plan for technical details. Keep repository prose/copy in English.
- [ ] Review the complete task diff using `changes-review`, including untracked files. Check that no second hierarchy model, inline business logic in contracts, duplicated paging widget, or nested interactive element was introduced.
- [ ] Perform the required frontend UX review following applicable project/skill instructions. Any delegated reviewer, if required by those instructions, receives read-only scope; implementation ownership remains in this worktree.
- [ ] Correct findings, then run the final workspace checks once from the repository root:

```sh
bun fmt
bun lint
bun typecheck
git diff --check
```

- [ ] Review formatter output and stage only task-owned changes. Do not accidentally include unrelated modifications from another checkout or copied configuration. Re-run affected focused tests only if fixes changed behavior.
- [ ] Commit the reviewed implementation and tests with Conventional Commits and the current toolkit trailer according to `git-paraty`. Do not fabricate passing checks or a toolkit version.
- [ ] Incorporate latest target/upstream advances by merge in the worktree. Revalidate affected code if this changes the implementation.
- [ ] Acquire the repository's shared exclusive integration lock at `<git-common-dir>/synara-integration.lock` by atomic directory creation. An existing lock means wait/retry; do not delete a lock owned by another task. Release only a lock acquired by this task, in a finally/cleanup handler. Recheck target cleanliness and ancestry under the lock. If the target has advanced, release the lock, merge that advance, validate affected code, and retry under the lock.
- [ ] If clean and target is an ancestor, fast-forward local `nacho/integration`. Verify the implementation commit is contained in the target before removing the clean task worktree/temporary branch. Never force an update or clean someone else's changes.
- [ ] If target has unrelated uncommitted changes, keep the committed implementation worktree and report the integration block and exact path. Do not stash/reset the target. No remote publication is included.

**Completion report must state:** changed behavior, focused test counts/results, browser flows and evidence locations, React Doctor outcome, fmt/lint/typecheck outcomes, final commit, and whether local integration succeeded. This plan document by itself does not constitute implementation or validation.

## Implementer handoff checklist

- [ ] Required hierarchy commit incorporated.
- [ ] All A01–A30 cases implemented and verified at the appropriate unit/browser level.
- [ ] One shared compact child row and one shared branch/paging control implementation.
- [ ] Activity title width preserved; classic controls live inside the row.
- [ ] Batch descendants compact despite null native parent.
- [ ] Five-child initial prefix; navigation/persistence/status behavior matches this file.
- [ ] No unapproved visual alternatives or deferred product decisions.
- [ ] Reviewed, checked, committed, and locally integrated or explicitly blocked with preserved work.
