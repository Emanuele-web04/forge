# Compact sidebar subagents

Orchestrator threads that spawn subagents (native `parentThreadId` links or batch/source
children with `parentThreadId === null`) render their descendants as nested rows under the
family root in every sidebar surface: Projects, Chats, Studio, Pinned, and Activity (including
Activity → Pinned). A child row keeps its parent's anatomy — own model icon, title, status glyph,
hover actions and hover card — indented under a vertical thread line; in Activity it collapses to
a single line.

## Fixed subagent slot

- Every classic one-line row ends with a fixed 44px subagent slot
  (`SidebarThreadBranchSlot`/`SidebarThreadBranchControl`, `layout="classic"`). Rows without
  children render the slot empty, so every title truncates at the same boundary and the toggle
  sits at the same x on every row. Activity rows (`layout="activity"`) reserve nothing: the
  toggle is content-sized and sits in the meta line right before the fixed time column, so it is
  omitted entirely on childless rows.
- With children the slot is the toggle: a rotating `DisclosureChevron` (12px classic, 11px
  Activity) plus the direct child count (`1`, `5`, `20`, `99+`) in a right-aligned tabular-nums
  span. The whole slot is the hit area, not just the chevron. Above 99 the visible text is
  `99+`; the accessible label and tooltip keep the exact number. The chevron is always visible;
  hover changes only the row background.
- Hover changes only the row background. Classic rows keep their meta chips, ⌘N hint and
  status glyph in an in-flow trailing cluster between the title and the slot; the hover actions
  overlay that cluster, so nothing to the right of them moves.
- The toggle only expands or collapses its branch. It never navigates, renames, selects, or opens a
  context menu. Enter, Space, click, and double-click all count as one toggle.
- Before the chevron, one aggregate glyph summarises descendants that are not currently visible:
  attention (approval, awaiting input, plan ready) with its count, otherwise running, otherwise an
  unread completion. Each hidden descendant is counted once, on its nearest visible ancestor. The
  attention aggregate is the only content allowed to widen the slot; it grows leftwards so the
  chevron and count never shift.
- When the active conversation is hidden inside a closed branch, the toggle is highlighted and its
  label says so. The parent row itself is not marked as current.

## Thread line and indentation

- The children list (`SidebarThreadHierarchyBranch`'s `<ul>`) carries a 1px `border-sidebar-border`
  left edge with `margin-left` equal to the parent row's left padding plus half of the 12px
  provider icon (`hierarchyThreadLineOffsetPx`), so the line runs under the centre of the parent's
  icon: 38px for project-nested roots (`pl-8`), 14px for flush rows and every child (`px-2`), 16px
  for Activity rows (`px-2.5`). Child rows sit 12px right of the line on every surface.
- Nested branches draw their own line from their own row; there is no per-depth indent table
  and no per-row connector.
- Expand/collapse uses the shared `DisclosureRegion` motion (220ms ease-out, reduced-motion safe);
  the last open subtree is retained for the exit animation.

## Child rows

- Classic children reuse the normal thread row: provider icon of the child's own model, the
  nickname/role label (accent colour from `subagentPresentation`) or the plain title for batch
  children, the status glyph and compact hover actions, then the fixed slot. They drop project,
  time, branch, PR and origin badges — those live in the hover card. Height and padding are the
  app's row tokens (`--app-density-row-height`, `px-2`).
- Activity roots keep two lines. The meta line has a fixed order: project (flex) · branch (up to
  150px, PR chip leading the branch name; omitted without branch or PR) · subagent toggle
  (omitted without children) · status glyph (omitted when idle) · time (34px, right-aligned
  tabular-nums). The time is the only rigid column, so the optional items always sit flush
  against it (`branch · › 2 · 4:29`) and the right edge aligns down the list.
- Activity children are one 30px line: the child's own provider icon, the nickname/role label or
  plain title, then the same toggle · status · time cluster aligned with the parent's time. They
  repeat neither project nor branch (inherited from the parent); model and effort live in the
  hover card.
- The hover card names the orchestrator ("Subagent of · <parent title>") for native subagents,
  keeps model + effort, and colours the status label with the status pill's own tone.

## Fixed initial prefix and paging

- Direct children sort by `createdAt` ascending, then by ID. Status and title never reorder siblings.
- An open branch shows the first five direct children. With more, a `Show N more` row reveals the
  rest; afterwards `Show less` resets the prefix to five, or to the active child's position if it is
  deeper.
- Visible-count state lives in memory only (`childVisibleCountByParentId`); it is shared across
  surfaces and never serialised. Closing a branch clears its entry.
- Grandchildren page under their own parent and do not consume the parent's five slots.

## Explicit reveal behaviour

- Navigating to a hidden descendant opens its ancestors, keeps sibling order, and enlarges the
  visible prefix through that child (activating child 17 renders 1–17).
- Ancestors opened by navigation are recorded in the persisted `expandedThreadIds` under
  `synara:sidebar-ui:v1`, so moving to another family leaves the previous one open at its size.
- Manually closing the branch that contains the active thread keeps it closed through status-only
  updates. Only a new explicit navigation reveals it again.
- On reload, expanded IDs are restored, visible limits reset to five, and the restored active path is
  revealed once.
- Only mounted thread rows take part in navigation and shortcuts. Closed branches are `inert`, and
  focus moves to the toggle before a collapsing region disappears.

Technical details, interfaces, and the acceptance matrix of the first iteration live in the
[implementation plan](../superpowers/plans/2026-09-07-compact-sidebar-subagents.md).
