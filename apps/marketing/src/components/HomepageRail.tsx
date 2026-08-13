// FILE: HomepageRail.tsx
// Purpose: Quiet desktop section navigation for the long marketing page.
// Layer: Client component

"use client";

import { useEffect, useState } from "react";
import { scrollToAnchor } from "@/lib/scrollToAnchor";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "providers", label: "Providers" },
  { id: "workflow", label: "Workflow" },
  { id: "privacy", label: "Privacy" },
  { id: "faq", label: "FAQ" },
  { id: "download", label: "Download" },
] as const;

// Uniform inactive line: every section rests at the same width (w-4) and grows one
// step on hover (w-5). The active line stays w-8 — exactly 2x the resting width, so
// active/inactive stay proportional. Literal classes so Tailwind JIT picks them up.
const LINE_CLASSES =
  "w-4 group-hover:w-5 bg-[var(--text-tertiary)] group-hover:bg-[var(--text-secondary)]";

export default function HomepageRail() {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    const sections = SECTIONS.map(({ id }) => document.getElementById(id)).filter(
      (section): section is HTMLElement => section !== null,
    );
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => {
            const distanceA = Math.abs(a.boundingClientRect.top - window.innerHeight * 0.3);
            const distanceB = Math.abs(b.boundingClientRect.top - window.innerHeight * 0.3);
            return distanceA - distanceB;
          });
        const next = visible[0]?.target.id;
        if (next) setActiveId(next);
      },
      {
        rootMargin: "-18% 0px -62% 0px",
        threshold: [0, 0.15, 0.5],
      },
    );

    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <nav
      aria-label="Homepage sections"
      className="fixed right-4 top-1/2 z-30 hidden -translate-y-1/2 [@media(min-width:1440px)]:block"
    >
      <ol className="flex flex-col items-end">
        {SECTIONS.map(({ id, label }) => {
          const active = activeId === id;
          return (
            <li key={id}>
              <a
                href={`#${id}`}
                onClick={(event) => {
                  // Smooth jump instead of the browser's instant one; the marker
                  // lights up immediately rather than waiting for the observer.
                  if (scrollToAnchor(id, event)) setActiveId(id);
                }}
                aria-current={active ? "location" : undefined}
                className="group flex h-5 items-center justify-end gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
              >
                <span className="pointer-events-none translate-x-1 whitespace-nowrap rounded-md border border-[var(--divide)] bg-[var(--page-bg)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] opacity-0 shadow-sm transition group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 motion-reduce:transition-none">
                  {label}
                </span>
                <span
                  aria-hidden="true"
                  className={`block h-[2px] rounded-sm transition-[width,background-color] motion-reduce:transition-none ${
                    active ? "w-8 bg-[var(--text-primary)]" : LINE_CLASSES
                  }`}
                />
                <span className="sr-only">{label}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
