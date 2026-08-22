// FILE: sessionBearer.ts
// Purpose: Cookie-independent remote session for browsers that drop Set-Cookie
//          on pairing navigations (notably Android Chrome through Tailscale).

export const SESSION_BEARER_STORAGE_KEY = "synara.sessionBearer";
export const SESSION_BEARER_QUERY_PARAM = "sb";

let memorySessionBearer: string | null = null;

export function readSessionBearer(
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): string | null {
  if (memorySessionBearer) return memorySessionBearer;
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
  storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  memorySessionBearer = trimmed;
  if (!storage) return;
  try {
    storage.setItem(SESSION_BEARER_STORAGE_KEY, trimmed);
  } catch {
    // Memory bearer still authorizes this tab when storage is blocked.
  }
}

export function clearSessionBearer(
  storage: Pick<Storage, "removeItem"> | null = defaultStorage(),
): void {
  memorySessionBearer = null;
  if (!storage) return;
  try {
    storage.removeItem(SESSION_BEARER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function authorizationHeaderFromSessionBearer(
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): Record<string, string> {
  const token = readSessionBearer(storage);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Pairing success navigates to `/?sb=<sessionToken>` so Android can finish
 * auth even when Set-Cookie and sessionStorage on `/pair` both fail.
 */
export function claimSessionBearerFromLocation(
  location: {
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
  },
  history: {
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  },
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage(),
): string | null {
  const searchParams = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(
    location.hash.startsWith("#") ? location.hash.slice(1) : location.hash,
  );
  const fromQuery = searchParams.get(SESSION_BEARER_QUERY_PARAM)?.trim() ?? "";
  const fromHash = hashParams.get(SESSION_BEARER_QUERY_PARAM)?.trim() ?? "";
  const token = fromQuery || fromHash;
  if (!token) {
    return readSessionBearer(storage);
  }

  writeSessionBearer(token, storage);
  searchParams.delete(SESSION_BEARER_QUERY_PARAM);
  hashParams.delete(SESSION_BEARER_QUERY_PARAM);
  const nextSearch = searchParams.toString();
  const nextHash = hashParams.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${nextHash ? `#${nextHash}` : ""}`,
  );
  return token;
}

function defaultStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
} | null {
  if (typeof window === "undefined") return null;
  return {
    getItem(key: string) {
      try {
        const fromLocal = window.localStorage?.getItem(key)?.trim();
        if (fromLocal) return fromLocal;
      } catch {}
      try {
        const fromSession = window.sessionStorage?.getItem(key)?.trim();
        if (fromSession) return fromSession;
      } catch {}
      return null;
    },
    setItem(key: string, value: string) {
      try {
        window.localStorage?.setItem(key, value);
      } catch {}
      try {
        window.sessionStorage?.setItem(key, value);
      } catch {}
    },
    removeItem(key: string) {
      try {
        window.localStorage?.removeItem(key);
      } catch {}
      try {
        window.sessionStorage?.removeItem(key);
      } catch {}
    },
  };
}
