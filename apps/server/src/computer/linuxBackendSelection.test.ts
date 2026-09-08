import { describe, expect, it } from "vitest";

import { KWIN_SERVICE } from "./kwinDbus.ts";
import {
  InvalidComputerBackendOverrideError,
  LINUX_BACKEND_CHOICES,
  nestedModeForChoice,
  parseComputerBackendOverride,
  selectLinuxBackend,
} from "./linuxBackendSelection.ts";

/** A host that owns the given bus names, or one whose bus cannot be reached. */
function host(options: { readonly names?: readonly string[]; readonly busError?: string } = {}) {
  const names = new Set(options.names ?? []);
  return (name: string) =>
    options.busError
      ? Promise.reject(new Error(options.busError))
      : Promise.resolve(names.has(name));
}

const KDE_HOST = host({ names: [KWIN_SERVICE] });
const GNOME_HOST = host();

describe("parseComputerBackendOverride", () => {
  it("accepts every backend the plan names, case-insensitively", () => {
    for (const choice of LINUX_BACKEND_CHOICES) {
      expect(parseComputerBackendOverride(choice.toUpperCase())).toBe(choice);
    }
    expect(parseComputerBackendOverride(undefined)).toBeUndefined();
    expect(parseComputerBackendOverride("  ")).toBeUndefined();
  });

  it("throws on a typo instead of silently booting the wrong tier", () => {
    // Every other env var here degrades to a default on bad input. This one
    // names the backend, so ignoring it would look like the override is broken.
    expect(() => parseComputerBackendOverride("protal")).toThrow(
      InvalidComputerBackendOverrideError,
    );
    expect(() => parseComputerBackendOverride("protal")).toThrow("nested-window");
  });

  it("has no shared-seat backend to name", () => {
    // Nothing in the tree drives the human's own seat, so the old portal name
    // is simply not a backend Synara has — the same refusal as any typo.
    expect(() => parseComputerBackendOverride("portal")).toThrow(
      InvalidComputerBackendOverrideError,
    );
  });
});

describe("selectLinuxBackend", () => {
  it("picks the KWin backend on a KDE host with no environment variables set", async () => {
    // The hard regression guard: a KDE user who sets nothing must land on
    // exactly the backend they had before any other backend existed.
    await expect(selectLinuxBackend({ env: {}, busNameHasOwner: KDE_HOST })).resolves.toMatchObject(
      {
        choice: "kwin",
        forced: false,
      },
    );
  });

  it("gives the agent its own headless desktop when nothing owns the KWin name", async () => {
    // The non-KDE default: never the human's seat, and never a window popping
    // up on the human's desktop either — the headless nested compositor is
    // the resolution, watched through the Computer pane alone.
    const selection = await selectLinuxBackend({ env: {}, busNameHasOwner: GNOME_HOST });

    expect(selection).toMatchObject({ choice: "nested", forced: false });
    expect(selection.reason).toContain("instead of sharing the human's");
    expect(selection.reason).toContain("nothing appears on this desktop");
  });

  it("ignores XDG_CURRENT_DESKTOP entirely, in both directions", async () => {
    // A login manager sets this and a user can override it; the compositor
    // owning the bus name is the only fact that decides whether KWin is there.
    await expect(
      selectLinuxBackend({ env: { XDG_CURRENT_DESKTOP: "GNOME" }, busNameHasOwner: KDE_HOST }),
    ).resolves.toMatchObject({ choice: "kwin" });
    await expect(
      selectLinuxBackend({ env: { XDG_CURRENT_DESKTOP: "KDE" }, busNameHasOwner: GNOME_HOST }),
    ).resolves.toMatchObject({ choice: "nested" });
  });

  it("puts the override ahead of everything, including a running KWin", async () => {
    const selection = await selectLinuxBackend({
      env: { SYNARA_COMPUTER_BACKEND: "nested", SYNARA_COMPUTER_NESTED: "window" },
      busNameHasOwner: KDE_HOST,
    });

    expect(selection).toMatchObject({ choice: "nested", forced: true });
    expect(selection.reason).toContain("no other backend is tried");
  });

  it("rejects SYNARA_COMPUTER_BACKEND=portal like any other unknown backend", async () => {
    await expect(
      selectLinuxBackend({ env: { SYNARA_COMPUTER_BACKEND: "portal" }, busNameHasOwner: KDE_HOST }),
    ).rejects.toThrow(InvalidComputerBackendOverrideError);
  });

  it("does not consult the bus at all when an override is set", async () => {
    let asked = 0;
    await selectLinuxBackend({
      env: { SYNARA_COMPUTER_BACKEND: "nested-window" },
      busNameHasOwner: (name) => {
        asked += 1;
        return KDE_HOST(name);
      },
    });

    expect(asked).toBe(0);
  });

  it("puts the nested opt-in ahead of auto-detection, in both modes", async () => {
    await expect(
      selectLinuxBackend({ env: { SYNARA_COMPUTER_NESTED: "1" }, busNameHasOwner: KDE_HOST }),
    ).resolves.toMatchObject({ choice: "nested", forced: false });
    await expect(
      selectLinuxBackend({
        env: { SYNARA_COMPUTER_NESTED: "window" },
        busNameHasOwner: GNOME_HOST,
      }),
    ).resolves.toMatchObject({ choice: "nested-window", forced: false });
  });

  it("picks the Hyprland backend when a live Hyprland session owns the environment", async () => {
    const selection = await selectLinuxBackend({
      env: { HYPRLAND_INSTANCE_SIGNATURE: "abc123" },
      busNameHasOwner: GNOME_HOST,
      hyprlandSessionPresent: () => true,
    });

    expect(selection).toMatchObject({ choice: "hyprland", forced: false });
    expect(selection.reason).toContain("real desktop");
  });

  it("puts Hyprland detection ahead of the KWin bus probe", async () => {
    // The decisive case: a stray kwin_wayland (a nested or headless test
    // compositor) can own org.kde.KWin on the session bus of a machine whose
    // human is sitting at a Hyprland desktop. The inherited instance signature
    // is direct evidence of that desktop and must win.
    let asked = 0;
    const selection = await selectLinuxBackend({
      env: {},
      busNameHasOwner: (name) => {
        asked += 1;
        return KDE_HOST(name);
      },
      hyprlandSessionPresent: () => true,
    });

    expect(selection.choice).toBe("hyprland");
    expect(asked).toBe(0);
  });

  it("does not detect Hyprland from the signature alone without a live socket", async () => {
    // The env var survives into terminals that outlive a crashed compositor
    // and into sessions this process spawned itself; the socket is the
    // liveness check, and without it the ordinary resolution continues.
    await expect(
      selectLinuxBackend({
        env: { HYPRLAND_INSTANCE_SIGNATURE: "stale" },
        busNameHasOwner: KDE_HOST,
        hyprlandSessionPresent: () => false,
      }),
    ).resolves.toMatchObject({ choice: "kwin" });
  });

  it("honors SYNARA_COMPUTER_BACKEND=hyprland ahead of detection", async () => {
    const selection = await selectLinuxBackend({
      env: { SYNARA_COMPUTER_BACKEND: "hyprland" },
      busNameHasOwner: KDE_HOST,
      hyprlandSessionPresent: () => false,
    });

    expect(selection).toMatchObject({ choice: "hyprland", forced: true });
  });

  it("gives the agent its own desktop when the session bus cannot answer at all", async () => {
    // A headless host or a service unit has no ambient bus. The KWin plugin
    // is unreachable without one, while the nested session starts its own, so
    // this is the one tier that can work - and the reason still names the bus
    // failure for anyone who expected KWin.
    const selection = await selectLinuxBackend({
      env: {},
      busNameHasOwner: host({ busError: "connect ENOENT /run/user/1000/bus" }),
    });

    expect(selection.choice).toBe("nested");
    expect(selection.reason).toContain("ENOENT");
  });

  it("rejects rather than guessing when the override is malformed", async () => {
    await expect(
      selectLinuxBackend({ env: { SYNARA_COMPUTER_BACKEND: "kwin2" }, busNameHasOwner: KDE_HOST }),
    ).rejects.toThrow(InvalidComputerBackendOverrideError);
  });
});

describe("nestedModeForChoice", () => {
  it("maps the two nested choices onto the compositor modes and nothing else", () => {
    expect(nestedModeForChoice("nested")).toBe("virtual");
    expect(nestedModeForChoice("nested-window")).toBe("window");
    expect(nestedModeForChoice("kwin")).toBeUndefined();
    expect(nestedModeForChoice("hyprland")).toBeUndefined();
  });
});
