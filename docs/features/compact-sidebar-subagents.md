# Compact sidebar subagents

Orchestrator threads that spawn subagents (native `parentThreadId` links or batch/source
children with `parentThreadId === null`) render their descendants as compact one-line rows
under the family root in every sidebar surface: Projects, Chats, Studio, Pinned, and Activity
(including Activity → Pinned).

## Numeric branch control

- The root row shows one small toggle with the direct child count only (`1`, `5`, `20`, `99+`).
  Above 99 the visible text is `99+`; the accessible label and tooltip keep the exact number.
- In Activity the toggle sits on the second line after the project label, so the title line keeps
  its full width. Classic roots place the same toggle in the trailing area after the title.
- Roots without children render no control, gutter, or spacer.
- The toggle only expands or collapses its branch. It never navigates, renames, selects, or opens a
  context menu. Enter, Space, click, and double-click all count as one toggle.
- Next to the counter, one aggregate glyph summarises descendants that are not currently visible:
  attention (approval, awaiting input, plan ready) with its count, otherwise running, otherwise an
  unread completion. Each hidden descendant is counted once, on its nearest visible ancestor.
- When the active conversation is hidden inside a closed branch, the toggle is highlighted and its
  label says so. The parent row itself is not marked as current.

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

## Compact child rows

- One line, 28px minimum on desktop, 44px minimum on coarse pointers. Title, nickname/role, status
  glyph, and the row's own numeric toggle when it has children. No project, time, branch, PR, or
  origin badges.
- Indentation is 12px per level, capped at 24px (12px for every level below 640px wide). The child
  row owns its connector line.
- Only mounted thread rows take part in navigation and shortcuts. Closed branches are `inert`, and
  focus moves to the toggle before a collapsing region disappears.

Technical details, interfaces, and the acceptance matrix live in the
[implementation plan](../superpowers/plans/2026-09-07-compact-sidebar-subagents.md).
