// FILE: sessionBearer.ts
// Purpose: Cookie-independent remote session for browsers that drop Set-Cookie
//          on pairing navigations (notably Android Chrome through Tailscale).

export const SESSION_BEARER_STORAGE_KEY = "synara.sessionBearer";

export function readSessionBearer(
  storage: Pick<Storage, "getItem"> | null = defaultSessionStorage(),
): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(SESSION_BEARER_STORAGE_KEY)?.trim() ?? "";
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeSessionBearer(
  token: string,
  storage: Pick<Storage, "setItem"> | null = defaultSessionStorage(),
): void {
  if (!storage) return;
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  try {
    storage.setItem(SESSION_BEARER_STORAGE_KEY, trimmed);
  } catch {
    // Private mode / quota: cookie pairing remains the primary path.
  }
}

export function clearSessionBearer(
  storage: Pick<Storage, "removeItem"> | null = defaultSessionStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(SESSION_BEARER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function authorizationHeaderFromSessionBearer(
  storage: Pick<Storage, "getItem"> | null = defaultSessionStorage(),
): Record<string, string> {
  const token = readSessionBearer(storage);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function defaultSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
