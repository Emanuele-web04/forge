// FILE: ParallelChatMock.tsx
// Purpose: Split / parallel-chats showcase image (two threads side by side).
// Layer: Marketing UI mock
// Note: Framed to match the hero screenshot; the SplitShowcase wrapper supplies
//       the elevated hero-style background behind it.

export function ParallelChatMock() {
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-black/5 sm:rounded-xl dark:ring-white/10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/split-syn.png"
        alt="Synara split view — two agent threads running in parallel in the same window"
        className="block h-auto w-full"
      />
    </div>
  );
}
