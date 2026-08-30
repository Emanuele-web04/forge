// FILE: mainWindowNavigationPolicy.ts
// Purpose: Keeps the privileged desktop renderer on Synara's configured app origin.
// Layer: Desktop main-process security policy

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The preload bridge is intentionally available to the Synara renderer, so a
 * top-level navigation must never transfer that bridge to unrelated content.
 * Compare URL authority fields explicitly because custom-scheme URL `origin`
 * values serialize as `null` in some runtimes.
 */
export function isAllowedMainWindowNavigation(targetUrl: string, appEntryUrl: string): boolean {
  const target = parseUrl(targetUrl);
  const appEntry = parseUrl(appEntryUrl);
  if (!target || !appEntry || target.username.length > 0 || target.password.length > 0) {
    return false;
  }
  return (
    target.protocol === appEntry.protocol &&
    target.hostname === appEntry.hostname &&
    target.port === appEntry.port
  );
}
