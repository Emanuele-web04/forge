// FILE: TerminalTabsMock.tsx
// Purpose: Process/terminal showcase image (running threads + terminal).
// Layer: Marketing UI mock
// Note: Framed to match the hero screenshot; the SplitShowcase wrapper supplies
//       the elevated hero-style background behind it.

export function TerminalTabsMock() {
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-black/5 sm:rounded-xl dark:ring-white/10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/terminals-syn.png"
        alt="Synara terminals — Terminal 1, 2, and 3 tabs with Claude Code running in the project directory"
        className="block h-auto w-full"
      />
    </div>
  );
}
