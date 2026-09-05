"use client";

import { useServerInsertedHTML } from "next/navigation";

const THEME_KEY = "synara-theme";

// Runs in every document, including Next's error-fallback shell
// (`<html id="__next_error__">` served for 404s on catch-all routes like
// /docs/nope). The initial `apply()` paints the stored theme before hydration;
// the debounced class MutationObserver re-asserts it afterwards, because
// hydration rewrites the <html> class attribute from the RSC tree, which does
// not know the stored theme — without the observer that rewrite strips `dark`
// and error pages render light. The observer is debounced (setTimeout 0) so it
// never races ThemeToggle, which flips the class and then writes localStorage
// synchronously in the same task.
const themeInit = `(function(){try{var d=document.documentElement;var K=${JSON.stringify(THEME_KEY)};function stored(){try{return localStorage.getItem(K)}catch(e){return null}}function apply(){var t=stored();if(t==='dark'){d.classList.add('dark');return}if(t==='light'){d.classList.remove('dark');return}window.matchMedia('(prefers-color-scheme: dark)').matches?d.classList.add('dark'):d.classList.remove('dark')}apply();window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(){if(!stored())apply()});if(!window.__synaraThemeObserver){window.__synaraThemeObserver=new MutationObserver(function(){setTimeout(apply,0)});window.__synaraThemeObserver.observe(d,{attributes:true,attributeFilter:['class']})}window.addEventListener('load',function(){setTimeout(apply,0)});setTimeout(apply,300)}catch(e){}})()`;

/** Injects theme sync into the HTML stream so it runs before paint without React 19 script-tag warnings. */
export function ThemeScript() {
  useServerInsertedHTML(() => (
    <script id="synara-theme-init" dangerouslySetInnerHTML={{ __html: themeInit }} />
  ));
  return null;
}
