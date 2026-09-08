import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  hyprlandBuildToolingPresent,
  hyprlandInstallStampPath,
  hyprlandPluginDirectory,
  hyprlandPrebuiltRoot,
  provisionHyprlandPlugin,
  readHyprlandPrebuiltManifest,
  resolveHyprlandInstallScriptPath,
  selectHyprlandPrebuilt,
  type HyprlandProvisionDependencies,
} from "./hyprlandPluginProvisioning.ts";

const temp = () => mkdtemp(join(tmpdir(), "synara-hypr-provision-"));

const disk =
  (...present: readonly string[]) =>
  (path: string) =>
    present.includes(path);

describe("paths", () => {
  it("resolves the plugin directory from the override, then XDG, then home", () => {
    expect(hyprlandPluginDirectory({ SYNARA_HYPRLAND_PLUGIN_DIR: "/opt/plugins" }, "/home/x")).toBe(
      "/opt/plugins",
    );
    expect(hyprlandPluginDirectory({ XDG_DATA_HOME: "/data" }, "/home/x")).toBe(
      "/data/synara/hyprland-computer-use/plugins",
    );
    expect(hyprlandPluginDirectory({}, "/home/x")).toBe(
      "/home/x/.local/share/synara/hyprland-computer-use/plugins",
    );
  });

  it("resolves the stamp path from the override, then XDG state, then home", () => {
    expect(hyprlandInstallStampPath({ SYNARA_HYPRLAND_STATE_ROOT: "/state" }, "/home/x")).toBe(
      "/state/install.stamp",
    );
    expect(hyprlandInstallStampPath({ XDG_STATE_HOME: "/xdg-state" }, "/home/x")).toBe(
      "/xdg-state/synara/hyprland-computer-use-plugin/install.stamp",
    );
    expect(hyprlandInstallStampPath({}, "/home/x")).toBe(
      "/home/x/.local/state/synara/hyprland-computer-use-plugin/install.stamp",
    );
  });
});

describe("build tooling probe", () => {
  const env = { PATH: "/usr/bin" };

  const TOOLS = ["/usr/bin/g++", "/usr/bin/make", "/usr/bin/pkg-config"];

  it("needs the Hyprland pkg-config marker and the whole toolchain together", () => {
    expect(
      hyprlandBuildToolingPresent(disk("/usr/share/pkgconfig/hyprland.pc", ...TOOLS), env),
    ).toBe(true);
    // Headers without a compiler, or a compiler without headers, both refuse.
    expect(hyprlandBuildToolingPresent(disk("/usr/share/pkgconfig/hyprland.pc"), env)).toBe(false);
    expect(hyprlandBuildToolingPresent(disk(...TOOLS), env)).toBe(false);
    expect(
      hyprlandBuildToolingPresent(
        disk("/usr/share/pkgconfig/hyprland.pc", "/usr/bin/g++", "/usr/bin/make"),
        env,
      ),
    ).toBe(false);
  });

  it("accepts the pkg-config file from any of its packaging locations", () => {
    for (const pc of [
      "/usr/lib/pkgconfig/hyprland.pc",
      "/usr/lib64/pkgconfig/hyprland.pc",
      "/usr/local/share/pkgconfig/hyprland.pc",
    ]) {
      expect(hyprlandBuildToolingPresent(disk(pc, ...TOOLS), env)).toBe(true);
    }
  });
});

describe("prebuilt root and install script resolution", () => {
  it("prefers the configured prebuilt directory, then the bundled candidates", () => {
    expect(
      hyprlandPrebuiltRoot("/mod", "/configured", (candidate) => candidate === "/configured"),
    ).toBe("/configured");
    expect(
      hyprlandPrebuiltRoot(
        "/mod",
        undefined,
        (candidate) => candidate === "/mod/computer-use-hyprland/prebuilt",
      ),
    ).toBe("/mod/computer-use-hyprland/prebuilt");
    expect(hyprlandPrebuiltRoot("/mod", undefined, () => false)).toBeUndefined();
  });

  it("finds the install script beside the module or falls back to the source tree", () => {
    const bundled = "/mod/computer-use-hyprland/scripts/install-and-load.sh";
    expect(resolveHyprlandInstallScriptPath("/mod", undefined, (path) => path === bundled)).toBe(
      bundled,
    );
    expect(
      resolveHyprlandInstallScriptPath("/repo/apps/server/src/computer", undefined, () => false),
    ).toBe("/repo/apps/server/native/computer-use-hyprland/scripts/install-and-load.sh");
    expect(
      resolveHyprlandInstallScriptPath("/mod", "/src-override", (path) =>
        path.startsWith("/src-override"),
      ),
    ).toBe("/src-override/scripts/install-and-load.sh");
  });
});

describe("prebuilt selection", () => {
  const manifest = {
    builds: [
      { hyprlandVersion: "0.56.2", arch: "x64", file: "a.so", sha256: "aa" },
      { hyprlandVersion: "0.57.0", arch: "x64", file: "b.so", sha256: "bb" },
      { hyprlandVersion: "0.56.2", arch: "arm64", file: "c.so", sha256: "cc" },
    ],
  };

  it("matches the exact Hyprland version and architecture, never a near miss", () => {
    // The plugin ABI churns per Hyprland release; a near miss aborts at load.
    expect(selectHyprlandPrebuilt(manifest, "0.56.2", "x64")?.file).toBe("a.so");
    expect(selectHyprlandPrebuilt(manifest, "0.56.2", "arm64")?.file).toBe("c.so");
    expect(selectHyprlandPrebuilt(manifest, "0.56.3", "x64")).toBeUndefined();
    expect(selectHyprlandPrebuilt(manifest, "0.56.2", "riscv64")).toBeUndefined();
  });

  it("treats a missing or corrupt manifest as no prebuilts, not as a failure", async () => {
    const dir = await temp();
    expect(await readHyprlandPrebuiltManifest(join(dir, "absent.json"))).toBeUndefined();
    await writeFile(join(dir, "bad.json"), "{ not json");
    expect(await readHyprlandPrebuiltManifest(join(dir, "bad.json"))).toBeUndefined();
  });
});

describe("provisioning", () => {
  const baseDeps = async (
    overrides: Partial<HyprlandProvisionDependencies> = {},
  ): Promise<HyprlandProvisionDependencies> => {
    const dir = await temp();
    return {
      pluginDirectory: join(dir, "plugins"),
      listInstalled: async () => [],
      hyprlandVersion: async () => "0.56.2",
      arch: "x64",
      buildFromSource: async () => {
        const built = join(dir, "built.so");
        await writeFile(built, "from source");
        return built;
      },
      stampPath: join(dir, "state", "install.stamp"),
      ...overrides,
    };
  };

  const prebuiltRootWith = async (build: {
    readonly hyprlandVersion: string;
    readonly bytes: string;
    readonly sha256?: string;
  }): Promise<string> => {
    const dir = await temp();
    const root = join(dir, "prebuilt");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "p.so"), build.bytes);
    const { createHash } = await import("node:crypto");
    const sha256 = build.sha256 ?? createHash("sha256").update(build.bytes).digest("hex");
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({
        builds: [{ hyprlandVersion: build.hyprlandVersion, arch: "x64", file: "p.so", sha256 }],
      }),
    );
    return root;
  };

  it("installs a matching prebuilt without ever invoking the compiler", async () => {
    const prebuiltRoot = await prebuiltRootWith({ hyprlandVersion: "0.56.2", bytes: "prebuilt" });
    let built = false;
    const deps = await baseDeps({
      prebuiltRoot,
      buildFromSource: async () => {
        built = true;
        return "unused";
      },
    });

    const result = await provisionHyprlandPlugin(deps);

    expect(result.action).toBe("installed-prebuilt");
    expect(built).toBe(false);
    expect(await readFile(join(deps.pluginDirectory, "SynaraComputerUsePluginV1.so"), "utf8")).toBe(
      "prebuilt",
    );
  });

  it("builds from source when no prebuilt matches the running Hyprland", async () => {
    const prebuiltRoot = await prebuiltRootWith({ hyprlandVersion: "0.55.0", bytes: "stale" });
    const deps = await baseDeps({ prebuiltRoot });

    const result = await provisionHyprlandPlugin(deps);

    expect(result.action).toBe("installed-from-source");
    expect(await readFile(join(deps.pluginDirectory, "SynaraComputerUsePluginV1.so"), "utf8")).toBe(
      "from source",
    );
  });

  it("builds from source when the running version cannot be read at all", async () => {
    // An unreadable version cannot prove a prebuilt matches, and a mismatched
    // plugin aborts inside the compositor — so the safe path is compiling
    // against the headers actually installed on this machine.
    const prebuiltRoot = await prebuiltRootWith({ hyprlandVersion: "0.56.2", bytes: "prebuilt" });
    const deps = await baseDeps({ prebuiltRoot, hyprlandVersion: async () => undefined });

    const result = await provisionHyprlandPlugin(deps);

    expect(result.action).toBe("installed-from-source");
  });

  it("refuses a prebuilt whose bytes do not match the manifest", async () => {
    const prebuiltRoot = await prebuiltRootWith({
      hyprlandVersion: "0.56.2",
      bytes: "tampered",
      sha256: "00",
    });

    await expect(provisionHyprlandPlugin(await baseDeps({ prebuiltRoot }))).rejects.toThrow(
      /failed its checksum/,
    );
  });

  it("never asks for a relogin — hyprctl loads by path into the live compositor", async () => {
    const result = await provisionHyprlandPlugin(await baseDeps());
    expect(result.requiresRelogin).toBe(false);
    expect(result.summary).not.toMatch(/[Ll]og out/);
  });

  it("records the Hyprland version it installed for, so a later refusal can name it", async () => {
    const deps = await baseDeps();
    await provisionHyprlandPlugin(deps);
    const stamp = await readFile(deps.stampPath, "utf8");

    expect(stamp).toContain("plugin_id=SynaraComputerUsePluginV1");
    expect(stamp).toContain("hyprland_version=0.56.2");
  });

  it("outranks and deletes the superseded build without touching other files", async () => {
    // A live compositor keeps the pruned inode mapped, so deleting is safe;
    // overwriting the same filename never is, hence the climbing suffix.
    const deps = await baseDeps({
      listInstalled: async () => ["SynaraComputerUsePluginV4.so"],
    });
    await mkdir(deps.pluginDirectory, { recursive: true });
    await writeFile(join(deps.pluginDirectory, "SynaraComputerUsePluginV4.so"), "old");
    await writeFile(join(deps.pluginDirectory, "keep-me.txt"), "unrelated");

    const result = await provisionHyprlandPlugin(deps);

    expect(result.pluginId).toBe("SynaraComputerUsePluginV5");
    const remaining = await readdir(deps.pluginDirectory);
    expect(remaining.toSorted()).toEqual(
      ["SynaraComputerUsePluginV5.so", "keep-me.txt"].toSorted(),
    );
  });
});
