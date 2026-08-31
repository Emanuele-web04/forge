// FILE: sidebarNavOrdering.ts
// Purpose: Keeps the primary sidebar nav (New thread, Kanban, Pull requests, Automations)
//          order and visibility stable across the sidebar and persisted settings.
// Layer: Web settings utility
// Exports: nav item ids, default order, and normalization helpers.

export const SIDEBAR_NAV_ITEM_IDS = ["newThread", "kanban", "pullRequests", "automations"] as const;

export type SidebarNavItemId = (typeof SIDEBAR_NAV_ITEM_IDS)[number];

export const DEFAULT_SIDEBAR_NAV_ORDER: readonly SidebarNavItemId[] = SIDEBAR_NAV_ITEM_IDS;

const SIDEBAR_NAV_ITEM_ID_SET: ReadonlySet<SidebarNavItemId> = new Set(SIDEBAR_NAV_ITEM_IDS);

export function isSidebarNavItemId(value: string): value is SidebarNavItemId {
  return SIDEBAR_NAV_ITEM_ID_SET.has(value as SidebarNavItemId);
}

export function normalizeHiddenSidebarNavItems(
  hiddenItems: ReadonlyArray<string>,
): SidebarNavItemId[] {
  const seen = new Set<SidebarNavItemId>();
  const result: SidebarNavItemId[] = [];
  for (const candidate of hiddenItems) {
    if (isSidebarNavItemId(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

export function normalizeSidebarNavOrder(order: ReadonlyArray<string>): SidebarNavItemId[] {
  const seen = new Set<SidebarNavItemId>();
  const result: SidebarNavItemId[] = [];
  for (const candidate of order) {
    if (isSidebarNavItemId(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  // Items shipped after the user persisted an order still surface, appended at the end.
  for (const item of DEFAULT_SIDEBAR_NAV_ORDER) {
    if (!seen.has(item)) {
      result.push(item);
    }
  }
  return result;
}
