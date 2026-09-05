"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { FiX } from "react-icons/fi";
import { ThemeToggle } from "@/components/ThemeToggle";

const links = [
  { href: "/install", label: "Install" },
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
] as const;

export default function MobileNav() {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="relative flex items-center gap-1.5 sm:hidden">
      <ThemeToggle />
      <Link
        href="/install"
        className="rounded-full border border-[var(--divide)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--mock-row)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
      >
        Download
      </Link>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={open ? "Close navigation" : "Open navigation"}
        onClick={() => setOpen((current) => !current)}
        className="flex size-8 items-center justify-center rounded-md text-[var(--text-primary)] transition-colors hover:bg-[var(--mock-row)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
      >
        {/* Both icons stay mounted and cross-fade so the swap matches the
            panel's motion instead of popping. */}
        <span className="relative grid size-[18px] place-items-center">
          <svg
            className={`col-start-1 row-start-1 size-[18px] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
              open ? "rotate-90 opacity-0" : "rotate-0 opacity-100"
            }`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden="true"
          >
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="3" y1="15" x2="12" y2="15" />
          </svg>
          <FiX
            className={`col-start-1 row-start-1 size-[18px] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
              open ? "rotate-0 opacity-100" : "-rotate-90 opacity-0"
            }`}
            aria-hidden="true"
          />
        </span>
      </button>

      {/*
        The panel stays mounted so it can transition on close as well as open.
        `invisible` + `inert` keep it out of hit testing, tab order, and the
        accessibility tree while collapsed; visibility is a discrete property,
        so it flips only after the fade-out finishes.
      */}
      <div
        id={menuId}
        inert={!open}
        className={`absolute right-0 top-11 z-50 w-[min(17rem,calc(100vw-2rem))] origin-top-right rounded-2xl border border-[var(--divide)] bg-[var(--card)] p-2 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.45)] transition-[opacity,transform,visibility] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          open
            ? "visible translate-y-0 scale-100 opacity-100"
            : "invisible -translate-y-1 scale-95 opacity-0"
        }`}
      >
        <nav aria-label="Mobile navigation" className="grid gap-1">
          <a
            href="https://x.com/trySynara"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="rounded-xl px-3 py-2.5 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--mock-row)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-link)]"
          >
            X
          </a>
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className="rounded-xl px-3 py-2.5 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--mock-row)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-link)]"
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
