// FILE: spaceGrouping.ts
// Purpose: One ordering, naming, and labelling rule for every list that groups projects by Space.
// Layer: Spaces presentation utility
// Why: The composer project picker, the sidebar project menu, and the bulk move dialog each
//      rebuilt "active space first, then Void, then the rest" plus the `Name · Active` label by
//      hand. Three copies drift; this is the single source they all read from.

import {
  RESERVED_VOID_SPACE_ID,
  SPACE_ICON_NAMES,
  type SpaceIconName,
  type SpaceId,
} from "@synara/contracts";

import type { Space } from "~/types";

/**
 * Void is not a stored Space, so its name and icon are defaults here rather than a row.
 * "Void" is Synara's word, not the user's — the presentation is overridable per install
 * (see `voidSpaceStore`), and every list renders whatever the user settled on instead of
 * these constants.
 */
export const DEFAULT_VOID_SPACE_NAME = "Void";
export const DEFAULT_VOID_SPACE_ICON = "black-hole";
/** Fallback for a Space whose icon is unknown, and what the editor opens on. */
export const DEFAULT_SPACE_ICON: SpaceIconName = "bag";

/** Void may also wear its own black hole, which is not part of the curated Space set. */
export type VoidSpaceIconName = SpaceIconName | typeof DEFAULT_VOID_SPACE_ICON;

export interface VoidSpacePresentation {
  readonly name: string;
  readonly icon: VoidSpaceIconName;
}

export const DEFAULT_VOID_SPACE: VoidSpacePresentation = {
  name: DEFAULT_VOID_SPACE_NAME,
  icon: DEFAULT_VOID_SPACE_ICON,
};

export function isVoidSpaceIconName(value: string): value is VoidSpaceIconName {
  return (
    value === DEFAULT_VOID_SPACE_ICON || (SPACE_ICON_NAMES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Narrows an icon that may be Void's to one a stored Space can hold. Only reachable if a
 * caller hands a Void icon to a Space; the Space editor never offers the black hole.
 */
export function toSpaceIconName(icon: VoidSpaceIconName): SpaceIconName {
  return icon === DEFAULT_VOID_SPACE_ICON ? DEFAULT_SPACE_ICON : icon;
}
/**
 * Void's stand-in wherever a `SpaceId | null` has to survive as a plain string — React
 * keys, menu radio values, storage records. `null` cannot fill any of those roles, and a
 * sentinel that three modules each spell out by hand is a sentinel that eventually only
 * two of them agree on.
 */
export const VOID_SPACE_KEY = RESERVED_VOID_SPACE_ID;

/**
 * Resolve stale persisted selection to Void before Space-scoped lists filter on it. A receipt-
 * fenced optimistic selection remains usable until shell hydration reaches the command sequence.
 */
export function resolveActiveSpaceId(
  activeSpaceId: SpaceId | null,
  spaces: ReadonlyArray<Space>,
  pendingActiveSpaceId: SpaceId | null = null,
): SpaceId | null {
  return activeSpaceId !== null &&
    (activeSpaceId === pendingActiveSpaceId || spaces.some((space) => space.id === activeSpaceId))
    ? activeSpaceId
    : null;
}

/** Narrows a `SpaceId | null` to the string key that stands in for it. */
export function spaceKey(spaceId: SpaceId | null): string {
  return spaceId ?? VOID_SPACE_KEY;
}

/** Shown when a project points at a Space that is not in the snapshot (mid-delete, stale route). */
const UNKNOWN_SPACE_NAME = "Unknown space";

export interface SpaceGroup<T> {
  readonly spaceId: SpaceId | null;
  readonly name: string;
  readonly icon: VoidSpaceIconName;
  readonly isActive: boolean;
  /** Group heading copy, including the active-space marker. */
  readonly label: string;
  readonly items: ReadonlyArray<T>;
  /** Stable React key — `null` (Void) is not usable as one. */
  readonly key: string;
}

export function spaceDisplayName(
  spaceId: SpaceId | null | undefined,
  spaces: ReadonlyArray<Space>,
  voidSpace: VoidSpacePresentation = DEFAULT_VOID_SPACE,
): string {
  if (!spaceId) return voidSpace.name;
  return spaces.find((space) => space.id === spaceId)?.name ?? UNKNOWN_SPACE_NAME;
}

export function spaceDisplayIcon(
  spaceId: SpaceId | null | undefined,
  spaces: ReadonlyArray<Space>,
  voidSpace: VoidSpacePresentation = DEFAULT_VOID_SPACE,
): VoidSpaceIconName {
  if (!spaceId) return voidSpace.icon;
  return spaces.find((space) => space.id === spaceId)?.icon ?? voidSpace.icon;
}

/**
 * Space ids in the order every grouped project list presents them: the space you are
 * working in first, then Void, then the remaining spaces in their user-defined order.
 */
export function orderedSpaceIdsForPicker(
  spaces: ReadonlyArray<Space>,
  activeSpaceId: SpaceId | null,
): ReadonlyArray<SpaceId | null> {
  const rest: ReadonlyArray<SpaceId | null> = [null, ...spaces.map((space) => space.id)].filter(
    (spaceId) => spaceId !== activeSpaceId,
  );
  return [activeSpaceId, ...rest];
}

/** Groups any project-shaped list by Space, dropping empty groups. */
export function groupItemsBySpace<T>(input: {
  items: ReadonlyArray<T>;
  spaces: ReadonlyArray<Space>;
  activeSpaceId: SpaceId | null;
  spaceIdOf: (item: T) => SpaceId | null;
  /** How the unfiled group presents itself; defaults to the built-in "Void". */
  voidSpace?: VoidSpacePresentation;
}): ReadonlyArray<SpaceGroup<T>> {
  const { activeSpaceId, items, spaceIdOf, spaces } = input;
  const voidSpace = input.voidSpace ?? DEFAULT_VOID_SPACE;

  // Bucket in one pass, preserving each item's incoming order within its group. Insertion
  // order also records the orphans (see below) in the order they were met, so the ordered
  // ids below only have to describe the groups we actually want to place.
  const itemsBySpaceId = new Map<SpaceId | null, T[]>();
  for (const item of items) {
    const spaceId = spaceIdOf(item);
    const bucket = itemsBySpaceId.get(spaceId);
    if (bucket) bucket.push(item);
    else itemsBySpaceId.set(spaceId, [item]);
  }

  const orderedSpaceIds = orderedSpaceIdsForPicker(spaces, activeSpaceId);
  // An item can point at a space the snapshot has not caught up with (a delete still in
  // flight). Grouping strictly by known spaces would drop it from the list entirely, so
  // stragglers get their own trailing group rather than disappearing.
  const knownSpaceIds = new Set(orderedSpaceIds);
  const orphanSpaceIds = [...itemsBySpaceId.keys()].filter(
    (spaceId) => !knownSpaceIds.has(spaceId),
  );

  return [...orderedSpaceIds, ...orphanSpaceIds].flatMap((spaceId) => {
    const groupItems = itemsBySpaceId.get(spaceId);
    if (!groupItems) return [];
    const isActive = spaceId === activeSpaceId;
    const name = spaceDisplayName(spaceId, spaces, voidSpace);
    return [
      {
        spaceId,
        name,
        icon: spaceDisplayIcon(spaceId, spaces, voidSpace),
        isActive,
        label: isActive ? `${name} · Active` : name,
        items: groupItems,
        key: spaceKey(spaceId),
      } satisfies SpaceGroup<T>,
    ];
  });
}
