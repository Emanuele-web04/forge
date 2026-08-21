import { describe, expect, it, vi } from "vitest";

import { bootstrapRemoteAuthGate, shouldRequireRemotePairing } from "./remoteAuthGate";

describe("shouldRequireRemotePairing", () => {
  it("only blocks unsigned-in browsers against a remote-reachable server", () => {
    expect(
      shouldRequireRemotePairing({
        isElectron: false,
        pathname: "/",
        authenticated: false,
        policy: "remote-reachable",
      }),
    ).toBe(true);
    expect(
      shouldRequireRemotePairing({
        isElectron: true,
        pathname: "/",
        authenticated: false,
        policy: "remote-reachable",
      }),
    ).toBe(false);
    expect(
      shouldRequireRemotePairing({
        isElectron: false,
        pathname: "/pair",
        authenticated: false,
        policy: "remote-reachable",
      }),
    ).toBe(false);
    expect(
      shouldRequireRemotePairing({
        isElectron: false,
        pathname: "/",
        authenticated: true,
        policy: "remote-reachable",
      }),
    ).toBe(false);
  });
});

describe("bootstrapRemoteAuthGate", () => {
  it("blocks the shell when the remote session is unauthenticated", async () => {
    const render = vi.fn();
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        authenticated: false,
        auth: { policy: "remote-reachable" },
      }),
    }));

    await expect(
      bootstrapRemoteAuthGate({
        isElectron: false,
        pathname: "/",
        fetch: fetch as typeof globalThis.fetch,
        render,
      }),
    ).resolves.toBe("blocked");
    expect(render).toHaveBeenCalledOnce();
  });

  it("allows the shell when an owner session already exists", async () => {
    const render = vi.fn();
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        authenticated: true,
        auth: { policy: "remote-reachable" },
      }),
    }));

    await expect(
      bootstrapRemoteAuthGate({
        isElectron: false,
        pathname: "/",
        fetch: fetch as typeof globalThis.fetch,
        render,
      }),
    ).resolves.toBe("ok");
    expect(render).not.toHaveBeenCalled();
  });
});
