// FILE: HandoffChatMock.tsx
// Purpose: Model-handoff showcase image (Hand off menu).
// Layer: Marketing UI mock
// Note: Framed to match the hero screenshot; the SplitShowcase wrapper supplies
//       the elevated hero-style background behind it.

export function HandoffChatMock() {
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-black/5 sm:rounded-xl dark:ring-white/10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/handoff-syn.png"
        alt="Synara hand-off menu — pass a thread to Claude, Cursor, Grok, OpenCode, or Pi mid-conversation"
        className="block h-auto w-full"
      />
    </div>
  );
}
