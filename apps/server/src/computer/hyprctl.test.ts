import { describe, expect, it } from "vitest";

import {
  detectRunningHyprlandVersion,
  hyprlandSessionPresent,
  listLoadedHyprlandPlugins,
  loadHyprlandPlugin,
  unloadHyprlandPlugin,
  type HyprctlRunner,
} from "./hyprctl.ts";

function runner(replies: Record<string, string>): HyprctlRunner {
  return (args) => {
    const key = args.join(" ");
    const reply = replies[key];
    if (reply === undefined) return Promise.reject(new Error(`unexpected hyprctl ${key}`));
    return Promise.resolve(reply);
  };
}

describe("hyprlandSessionPresent", () => {
  it("needs the signature, the runtime dir, and the live socket together", () => {
    const env = { HYPRLAND_INSTANCE_SIGNATURE: "sig1", XDG_RUNTIME_DIR: "/run/user/1000" };
    const socket = "/run/user/1000/hypr/sig1/.socket.sock";

    expect(hyprlandSessionPresent(env, (path) => path === socket)).toBe(true);
    // The signature outlives a crashed compositor; the socket is the liveness check.
    expect(hyprlandSessionPresent(env, () => false)).toBe(false);
    expect(hyprlandSessionPresent({ XDG_RUNTIME_DIR: "/run/user/1000" }, () => true)).toBe(false);
    expect(hyprlandSessionPresent({ HYPRLAND_INSTANCE_SIGNATURE: "sig1" }, () => true)).toBe(false);
  });
});

describe("listLoadedHyprlandPlugins", () => {
  it("reads names out of the JSON plugin list", async () => {
    const run = runner({
      "-j plugin list": JSON.stringify([
        { name: "synara-computer-use", author: "Synara", handle: "0x1", version: "0.1" },
        { name: "hyprbars" },
      ]),
    });

    await expect(listLoadedHyprlandPlugins(run)).resolves.toEqual([
      { name: "synara-computer-use" },
      { name: "hyprbars" },
    ]);
  });

  it("treats an unparseable reply as an empty list rather than failing", async () => {
    const run = runner({ "-j plugin list": "no plugins loaded" });

    await expect(listLoadedHyprlandPlugins(run)).resolves.toEqual([]);
  });
});

describe("loadHyprlandPlugin", () => {
  it("succeeds only on the literal ok reply — hyprctl always exits 0", async () => {
    const path = "/home/user/plug.so";
    const okRun = runner({ [`plugin load ${path}`]: "ok\n" });
    const refusingRun = runner({
      [`plugin load ${path}`]: `Plugin ${path} could not be loaded: API version mismatch`,
    });

    await expect(loadHyprlandPlugin(okRun, path)).resolves.toEqual({ ok: true, message: "ok" });
    const refused = await loadHyprlandPlugin(refusingRun, path);
    expect(refused.ok).toBe(false);
    // Hyprland's own reason is the whole value of the reply; it must survive.
    expect(refused.message).toContain("API version mismatch");
  });
});

describe("unloadHyprlandPlugin", () => {
  it("maps ok and not-loaded onto the KWin unload contract", async () => {
    const path = "/home/user/plug.so";

    await expect(
      unloadHyprlandPlugin(runner({ [`plugin unload ${path}`]: "ok" }), path),
    ).resolves.toBe(true);
    await expect(
      unloadHyprlandPlugin(runner({ [`plugin unload ${path}`]: "plugin not loaded" }), path),
    ).resolves.toBe(false);
    await expect(
      unloadHyprlandPlugin(runner({ [`plugin unload ${path}`]: "something exploded" }), path),
    ).rejects.toThrow("something exploded");
  });
});

describe("detectRunningHyprlandVersion", () => {
  it("reads the version field and answers undefined for anything else", async () => {
    await expect(
      detectRunningHyprlandVersion(
        runner({ "-j version": '{"version":"0.56.2","tag":"v0.56.2"}' }),
      ),
    ).resolves.toBe("0.56.2");
    await expect(
      detectRunningHyprlandVersion(runner({ "-j version": "not json" })),
    ).resolves.toBeUndefined();
    await expect(detectRunningHyprlandVersion(runner({}))).resolves.toBeUndefined();
  });
});
