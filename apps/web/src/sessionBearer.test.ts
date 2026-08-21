import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_BEARER_STORAGE_KEY,
  authorizationHeaderFromSessionBearer,
  claimSessionBearerFromLocation,
  clearSessionBearer,
  readSessionBearer,
  writeSessionBearer,
} from "./sessionBearer";

describe("sessionBearer", () => {
  beforeEach(() => {
    clearSessionBearer({
      removeItem: () => undefined,
    });
  });

  it("round-trips through storage and builds an Authorization header", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };

    writeSessionBearer("  token-one  ", storage);
    expect(readSessionBearer(storage)).toBe("token-one");
    expect(authorizationHeaderFromSessionBearer(storage)).toEqual({
      Authorization: "Bearer token-one",
    });
    expect(store.get(SESSION_BEARER_STORAGE_KEY)).toBe("token-one");
    clearSessionBearer(storage);
    expect(readSessionBearer(storage)).toBeNull();
    expect(authorizationHeaderFromSessionBearer(storage)).toEqual({});
  });

  it("claims a one-shot sb query param into session storage and scrubs the URL", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const replaceState = vi.fn();

    expect(
      claimSessionBearerFromLocation(
        { pathname: "/", search: "?sb=pair-token&x=1", hash: "" },
        { replaceState },
        storage,
      ),
    ).toBe("pair-token");
    expect(store.get(SESSION_BEARER_STORAGE_KEY)).toBe("pair-token");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?x=1");
  });
});
