// FILE: OneClickPrMock.tsx
// Purpose: One-click PR showcase image (Git actions menu).
// Layer: Marketing UI mock
// Note: Framed to match the hero screenshot; the SplitShowcase wrapper supplies
//       the elevated hero-style background behind it.

export function OneClickPrMock() {
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-black/5 sm:rounded-xl dark:ring-white/10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/git-syn.png"
        alt="Synara git actions — commit, pull, push, create PR, and create branch in one click"
        className="block h-auto w-full"
      />
    </div>
  );
}
