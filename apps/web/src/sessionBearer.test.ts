import { describe, expect, it } from "vitest";

import {
  SESSION_BEARER_STORAGE_KEY,
  authorizationHeaderFromSessionBearer,
  clearSessionBearer,
  readSessionBearer,
  writeSessionBearer,
} from "./sessionBearer";

describe("sessionBearer", () => {
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
});
