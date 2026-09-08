import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Synara",
  description: "Public Synara profiles",
};

/**
 * Applies `.dark` before first paint from the `synara-theme` localStorage
 * key. The marketing site currently persists its toggle under a legacy key,
 * so cross-surface carryover resumes once it migrates to this one; until
 * then each surface remembers its own choice. No stored value falls back to
 * the system scheme and tracks live preference changes.
 */
const THEME_INIT = `(function(){try{var d=document.documentElement;var K="synara-theme";function stored(){try{return localStorage.getItem(K)}catch(e){return null}}function apply(){var t=stored();if(t==="dark"){d.classList.add("dark");return}if(t==="light"){d.classList.remove("dark");return}window.matchMedia("(prefers-color-scheme: dark)").matches?d.classList.add("dark"):d.classList.remove("dark")}apply();window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){if(!stored())apply()})}catch(e){}})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the init script mutates <html> class before
    // React hydrates, which is the whole point — not a hydration bug.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline theme bootstrap, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
