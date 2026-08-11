// FILE: ForkTypeLorePanel.tsx
// Purpose: Playful fork-type selection surface that distinguishes operational Git
// forks from parody-only fork taxonomy.

import { useState } from "react";

const FORK_TYPES = [
  {
    id: "git",
    emoji: "🍴",
    label: "Git fork",
    description:
      "Functional repository fork with history, remotes, and upstream relationship tracking.",
    mode: "functional",
  },
  {
    id: "dinner",
    emoji: "🍽️",
    label: "Dinner fork",
    description: "Parody workflow for plating, sharing, and passing forked ideas without remotes.",
    mode: "parody",
  },
  {
    id: "tuning",
    emoji: "🎵",
    label: "Tuning fork",
    description: "Parody workflow for striking a useful note before opening a PR discussion.",
    mode: "parody",
  },
  {
    id: "pitchfork",
    emoji: "🔥",
    label: "Pitchfork",
    description: "Parody workflow for discussion forks and social choreography, not merge flow.",
    mode: "parody",
  },
  {
    id: "spork",
    emoji: "🥄",
    label: "Spork",
    description: "Parody fork for hybrid processes that refuse to be one-dimensional.",
    mode: "parody",
  },
  {
    id: "chess",
    emoji: "♟️",
    label: "Chess fork",
    description: "Parody strategy fork with an emphasis on attack coverage and tempo.",
    mode: "parody",
  },
  {
    id: "process",
    emoji: "🛣️",
    label: "Process fork",
    description: "Parody workflow for branching processes and priorities, mostly symbolic.",
    mode: "parody",
  },
] as const;

type ForkTypeId = (typeof FORK_TYPES)[number]["id"];

function isParodyFork(typeId: ForkTypeId): boolean {
  const forkType = FORK_TYPES.find((fork) => fork.id === typeId);
  return forkType?.mode === "parody";
}

export function ForkTypeLorePanel() {
  const [selectedForkType, setSelectedForkType] = useState<ForkTypeId>("git");
  const selectedDefinition = FORK_TYPES.find((fork) => fork.id === selectedForkType);
  const selectedMode = isParodyFork(selectedForkType)
    ? "parody-only content"
    : "functional git surface";

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Fork types
      </h2>
      <p className="text-sm text-muted-foreground">
        Choose a fork identity for framing and narration. Git retains all live repository behavior.
      </p>

      <fieldset className="space-y-2">
        <legend className="sr-only">Fork type selector</legend>
        <div role="radiogroup" aria-label="Fork type selector">
          {FORK_TYPES.map((forkType) => {
            const isSelected = selectedForkType === forkType.id;
            return (
              <label
                key={forkType.id}
                className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm transition ${
                  isSelected
                    ? "border-foreground/35 bg-foreground/5"
                    : "border-border bg-background"
                }`}
              >
                <input
                  type="radio"
                  name="fork-lore-type"
                  value={forkType.id}
                  checked={isSelected}
                  className="mt-1 h-4 w-4"
                  onChange={() => setSelectedForkType(forkType.id)}
                  aria-label={`Select ${forkType.label}`}
                />
                <span aria-hidden="true">{forkType.emoji}</span>
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{forkType.label}</span>
                  <span className="mt-0.5 block text-muted-foreground">{forkType.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Selected mode:</span> {selectedMode}
        {selectedDefinition ? ` — ${selectedDefinition.label}` : ""}. Forkara operationally treats
        non-Git entries as parody-only content.
      </p>
    </section>
  );
}
