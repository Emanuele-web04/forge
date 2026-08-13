// FILE: WorktreeMock.tsx
// Purpose: Worktree-native showcase image (worktree sessions list).
// Layer: Marketing UI mock
// Note: Framed to match the hero screenshot; the SplitShowcase wrapper supplies
//       the elevated hero-style background behind it.

export function WorktreeMock() {
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-black/5 sm:rounded-xl dark:ring-white/10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/worktrees-syn.png"
        alt="Synara worktree sessions — a separate branch per agent, each on its own worktree"
        className="block h-auto w-full"
      />
    </div>
  );
}
