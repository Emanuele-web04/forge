import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Synara",
  description: "Public Synara profiles",
};

/**
 * Applies `.dark` before first paint from the SAME localStorage key the
 * marketing site uses (`dpcode-theme`) — the /@handle rewrite serves this app
 * on the trysynara.com origin, so a theme chosen on either surface follows
 * the visitor to the other. No stored value falls back to the system scheme
 * and tracks live preference changes.
 */
const THEME_INIT = `(function(){try{var d=document.documentElement;var K="dpcode-theme";function stored(){try{return localStorage.getItem(K)}catch(e){return null}}function apply(){var t=stored();if(t==="dark"){d.classList.add("dark");return}if(t==="light"){d.classList.remove("dark");return}window.matchMedia("(prefers-color-scheme: dark)").matches?d.classList.add("dark"):d.classList.remove("dark")}apply();window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){if(!stored())apply()})}catch(e){}})()`;

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
