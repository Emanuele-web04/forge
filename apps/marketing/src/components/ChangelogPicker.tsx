// FILE: ChangelogPicker.tsx
// Purpose: Compact release picker shown in the header on small screens (where the
//          right-rail doesn't fit). A native <select> — so phones get the OS
//          wheel/list picker — that jumps to the chosen release and reflects the
//          one currently in view. Hidden at md+ (the rail takes over).
// Layer: Client component; shares scroll-spy with the rail via useActiveAnchor.

"use client";

import { LuChevronDown } from "react-icons/lu";
import { type ChangelogNavItem, useActiveAnchor } from "@/lib/useActiveAnchor";

export default function ChangelogPicker({ items }: { items: ChangelogNavItem[] }) {
  const { active, jumpTo } = useActiveAnchor(items);

  return (
    <div className="relative inline-flex md:hidden">
      <select
        aria-label="Jump to release"
        value={active ?? items[0]?.anchor ?? ""}
        onChange={(event) => jumpTo(event.target.value)}
        className="cursor-pointer appearance-none rounded-full border border-[var(--divide)] bg-[var(--block-elevated)] py-1 pr-5 pl-2.5 font-mono text-[10px] tracking-[0.04em] text-[var(--text-secondary)] uppercase outline-none transition-colors [color-scheme:light] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-link)] dark:[color-scheme:dark]"
      >
        {items.map((item) => (
          <option key={item.anchor} value={item.anchor}>
            {item.version} · {item.date}
          </option>
        ))}
      </select>
      <LuChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-1.5 size-2.5 -translate-y-1/2 text-[var(--text-tertiary)]"
      />
    </div>
  );
}
