"use client";

// The light/dark toggle: writes the `synara-theme` localStorage key and
// flips `.dark` on <html>. The only client component this app has —
// everything else stays SSR.

import { useEffect, useState } from "react";

const THEME_KEY = "synara-theme";

function isDarkNow(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function ThemeToggle() {
  // null until mounted: the server cannot know the theme, so the button
  // renders both glyphs stacked and reveals the right one after hydration —
  // avoiding a flash-of-wrong-icon without suppressing hydration checks.
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(isDarkNow());
  }, []);

  const toggle = () => {
    const next = !isDarkNow();
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {
      // Storage unavailable (private mode): the flip still applies this visit.
    }
    setDark(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark === true ? "Switch to light mode" : "Switch to dark mode"}
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {dark !== false && (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={dark === null ? "hidden" : undefined}
          aria-hidden
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
        </svg>
      )}
      {dark !== true && (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={dark === null ? "hidden" : undefined}
          aria-hidden
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
