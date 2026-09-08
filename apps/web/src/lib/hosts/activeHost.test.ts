// The active-host choice survives a reload (sessionStorage), rejects junk,
// and turns into the socket prefix the transport prepends. Web unit tests run
// without a DOM, so `window` is stubbed with an in-memory sessionStorage the
// same way the storage-migration tests stub localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readActiveHost, readActiveHostSocketPrefix } from "./activeHost";

const KEY = "synara:active-host:v1";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

let sessionStorage: Storage;

beforeEach(() => {
  sessionStorage = createMemoryStorage();
  vi.stubGlobal("window", { sessionStorage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("activeHost", () => {
  it("is null when nothing is chosen", () => {
    expect(readActiveHost()).toBeNull();
    expect(readActiveHostSocketPrefix()).toBeNull();
  });

  it("reads a stored choice and derives the socket prefix without a trailing slash", () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ hostId: "host_1", hostName: "Ada", wsPath: "/ws/remote/host_1/" }),
    );
    expect(readActiveHost()).toEqual({
      hostId: "host_1",
      hostName: "Ada",
      wsPath: "/ws/remote/host_1/",
    });
    expect(readActiveHostSocketPrefix()).toBe("/ws/remote/host_1");
  });

  it("drops a corrupt or non-path value rather than pointing the transport at it", () => {
    sessionStorage.setItem(KEY, "not json");
    expect(readActiveHost()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();

    sessionStorage.setItem(
      KEY,
      JSON.stringify({ hostId: "host_1", hostName: "Ada", wsPath: "https://evil.test/ws" }),
    );
    expect(readActiveHost()).toBeNull();
  });

  it("is null when there is no window at all", () => {
    vi.unstubAllGlobals();
    expect(readActiveHost()).toBeNull();
  });
});
