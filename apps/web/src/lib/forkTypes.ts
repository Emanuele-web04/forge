// FILE: forkTypes.ts
// Purpose: Reusable fork-type catalog for parody and Git-functional distinctions.
// Layer: Shared UI/data model
// Exports: Fork type metadata consumed by fork-related surfaces and future copy.

export interface ForkTypeEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly icon: string;
  readonly isFunctionalIntegration: boolean;
}

export const FORK_TYPES: readonly ForkTypeEntry[] = [
  {
    id: "git-fork",
    displayName: "Git Fork",
    description: "Functional repository-derived code branching workflow with full sync support.",
    icon: "🍴",
    isFunctionalIntegration: true,
  },
  {
    id: "dinner-fork",
    displayName: "Dinner Fork",
    description: "Shared dish split for social rituals, not code synchronization.",
    icon: "🍴",
    isFunctionalIntegration: false,
  },
  {
    id: "tuning-fork",
    displayName: "Tuning Fork",
    description: "Conceptual fork where two ideas vibrate in agreement or drift apart.",
    icon: "🎵",
    isFunctionalIntegration: false,
  },
  {
    id: "pitchfork",
    displayName: "Pitchfork",
    description: "Provocative fork of support; sharp edges, no git remotes.",
    icon: "🔥",
    isFunctionalIntegration: false,
  },
  {
    id: "spork",
    displayName: "Spork",
    description: "Pragmatic hybrid fork for improv tasks that still isn’t a repo clone.",
    icon: "🥄",
    isFunctionalIntegration: false,
  },
  {
    id: "chess-fork",
    displayName: "Chess Fork",
    description: "A tactical forking moment where one move attacks multiple priorities.",
    icon: "♟️",
    isFunctionalIntegration: false,
  },
] as const;

export type ForkTypeId = (typeof FORK_TYPES)[number]["id"];

export function getForkType(entryId: ForkTypeId): ForkTypeEntry | undefined {
  return FORK_TYPES.find((entry) => entry.id === entryId);
}
