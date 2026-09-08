import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ENV_SCRIPT_NAME,
  ensureEnvScript,
  envScriptPath,
  installPluginBinary,
  nextPluginId,
  pruneSupersededPlugins,
  provisionKWinPlugin,
  readPrebuiltManifest,
  renderEnvScript,
  resolveInstallTarget,
  selectPrebuilt,
  sessionSeesPluginRoot,
  verifyPrebuilt,
  type ProvisionDependencies,
} from "./kwinPluginProvisioning.ts";

const temp = () => mkdtemp(join(tmpdir(), "synara-provision-"));

/** The candidate list every caller passes: both spellings, in preference order. */
const SYSTEM_QT_ROOTS = ["/usr/lib64/qt6/plugins", "/usr/lib/qt6/plugins"];
const onDisk =
  (...present: readonly string[]) =>
  (path: string) =>
    present.includes(path);

describe("install target", () => {
  it("follows the system Qt's lib64/lib split rather than guessing it", () => {
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib64/qt6/plugins"))
        .qtPluginRoot,
    ).toBe("/home/x/.local/lib64/qt6/plugins");
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib/qt6/plugins")).qtPluginRoot,
    ).toBe("/home/x/.local/lib/qt6/plugins");
  });

  /**
   * The regression that mattered: every caller hands over both spellings, so a
   * decision made by reading the list rather than the disk answered lib64 on
   * Debian and Arch too, and installed the plugin into a directory the env
   * script never put on QT_PLUGIN_PATH.
   */
  it("reads the split off the disk, not off the candidate list", () => {
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib/qt6/plugins")).qtPluginRoot,
    ).toBe("/home/x/.local/lib/qt6/plugins");
    // Neither present: the script's `else` branch, which is lib.
    expect(resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk()).qtPluginRoot).toBe(
      "/home/x/.local/lib/qt6/plugins",
    );
  });

  it("puts the plugin where KWin scans, under the root it will be told about", () => {
    const target = resolveInstallTarget(
      SYSTEM_QT_ROOTS,
      "/home/x",
      onDisk("/usr/lib64/qt6/plugins"),
    );
    expect(target.pluginDirectory).toBe(`${target.qtPluginRoot}/kwin/plugins`);
  });

  it("never leaves the home directory, which is the whole point of not needing sudo", () => {
    for (const present of [["/usr/lib64/qt6/plugins"], ["/usr/lib/qt6/plugins"], []]) {
      expect(
        resolveInstallTarget(
          SYSTEM_QT_ROOTS,
          "/home/x",
          onDisk(...present),
        ).pluginDirectory.startsWith("/home/x/"),
      ).toBe(true);
    }
  });
});

describe("session env script", () => {
  it("lands where the Plasma session sources it", () => {
    expect(envScriptPath({ XDG_CONFIG_HOME: "/c" }, "/home/x")).toBe(
      `/c/plasma-workspace/env/${ENV_SCRIPT_NAME}`,
    );
    expect(envScriptPath({}, "/home/x")).toBe(
      `/home/x/.config/plasma-workspace/env/${ENV_SCRIPT_NAME}`,
    );
  });

  it("is safe to source twice and keeps any path the user already had", async () => {
    const script = renderEnvScript("/home/x/.local/lib64/qt6/plugins");
    const dir = await temp();
    const path = join(dir, "env.sh");
    await writeFile(path, script);

    const { execFile } = await import("node:child_process");
    const run = (existing: string): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(
          "sh",
          [
            "-c",
            `QT_PLUGIN_PATH='${existing}'; . '${path}'; . '${path}'; printf '%s' "$QT_PLUGIN_PATH"`,
          ],
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });

    expect(await run("")).toBe("/home/x/.local/lib64/qt6/plugins");
    // Sourced twice, listed once, and the pre-existing entry survives.
    expect(await run("/opt/other")).toBe("/home/x/.local/lib64/qt6/plugins:/opt/other");
  });

  it("rewrites only when the content actually changed", async () => {
    const dir = await temp();
    const path = join(dir, "nested", "env.sh");
    const contents = renderEnvScript("/root");

    expect(await ensureEnvScript(path, contents)).toBe("written");
    expect(await ensureEnvScript(path, contents)).toBe("unchanged");
    expect(await ensureEnvScript(path, renderEnvScript("/other"))).toBe("written");
    expect(await readFile(path, "utf8")).toContain("/other");
    // Sourced by the session, so it has to be executable.
    expect((await stat(path)).mode & 0o111).toBeTruthy();
  });
});

describe("what the running compositor can see", () => {
  it("reads the session's own QT_PLUGIN_PATH, exact entries only", () => {
    const root = "/home/x/.local/lib64/qt6/plugins";
    expect(sessionSeesPluginRoot(root, { QT_PLUGIN_PATH: `/a:${root}:/b` })).toBe(true);
    expect(sessionSeesPluginRoot(root, { QT_PLUGIN_PATH: "" })).toBe(false);
    expect(sessionSeesPluginRoot(root, {})).toBe(false);
    // A prefix is not the directory: /home/x/.local/lib64/qt6/plugins-old is a
    // different place, and treating it as a match would report a plugin as ready
    // to load when KWin has never scanned for it.
    expect(sessionSeesPluginRoot(root, { QT_PLUGIN_PATH: `${root}-old` })).toBe(false);
  });
});

describe("prebuilt selection", () => {
  const manifest = {
    builds: [
      { kwinVersion: "6.7.3", arch: "x64", file: "a.so", sha256: "aa" },
      { kwinVersion: "6.8.0", arch: "x64", file: "b.so", sha256: "bb" },
      { kwinVersion: "6.7.3", arch: "arm64", file: "c.so", sha256: "cc" },
    ],
  };

  it("matches the exact KWin version and architecture", () => {
    expect(selectPrebuilt(manifest, "6.7.3", "x64")?.file).toBe("a.so");
    expect(selectPrebuilt(manifest, "6.7.3", "arm64")?.file).toBe("c.so");
  });

  it("never settles for a near miss, which would fail at load with no reason given", () => {
    expect(selectPrebuilt(manifest, "6.7.4", "x64")).toBeUndefined();
    expect(selectPrebuilt(manifest, "6.7", "x64")).toBeUndefined();
    expect(selectPrebuilt(manifest, "6.7.3", "riscv64")).toBeUndefined();
  });

  it("treats a missing or corrupt manifest as no prebuilts, not as a failure", async () => {
    const dir = await temp();
    expect(await readPrebuiltManifest(join(dir, "absent.json"))).toBeUndefined();
    await writeFile(join(dir, "bad.json"), "{ not json");
    expect(await readPrebuiltManifest(join(dir, "bad.json"))).toBeUndefined();
  });
});

describe("checksum", () => {
  it("passes the file it was computed from and fails anything else", async () => {
    const dir = await temp();
    const path = join(dir, "plugin.so");
    await writeFile(path, "binary");
    // sha256("binary")
    const digest = "9d0e05e02e0e5e37f52d5c4c1d1b0d2f0b8f6e0e1a58ba2e6f3e0b2f7bd9b7e2";
    expect(await verifyPrebuilt(path, digest)).toBe(false);
    const { createHash } = await import("node:crypto");
    const real = createHash("sha256").update("binary").digest("hex");
    expect(await verifyPrebuilt(path, real)).toBe(true);
    expect(await verifyPrebuilt(join(dir, "absent.so"), real)).toBe(false);
  });
});

describe("plugin id", () => {
  it("outranks every installed version, because KWin pins the file it loaded", () => {
    expect(nextPluginId([])).toBe("SynaraComputerUsePluginV1");
    expect(nextPluginId(["SynaraComputerUsePluginV3.so", "SynaraComputerUsePluginV11.so"])).toBe(
      "SynaraComputerUsePluginV12",
    );
    expect(nextPluginId(["notes.txt", "SynaraComputerUsePlugin.so"])).toBe(
      "SynaraComputerUsePluginV1",
    );
  });
});

describe("provisioning", () => {
  const baseDeps = async (
    overrides: Partial<ProvisionDependencies> = {},
  ): Promise<ProvisionDependencies> => {
    const dir = await temp();
    return {
      target: {
        qtPluginRoot: join(dir, "plugins"),
        pluginDirectory: join(dir, "plugins", "kwin", "plugins"),
      },
      env: { XDG_CONFIG_HOME: join(dir, "config") },
      stampPath: join(dir, "state", "install.stamp"),
      listInstalled: async () => [],
      kwinVersion: async () => "6.7.3",
      arch: "x64",
      buildFromSource: async () => {
        const built = join(dir, "built.so");
        await writeFile(built, "from source");
        return built;
      },
      isCurrent: async () => false,
      ...overrides,
    };
  };

  it("installs a matching prebuilt without ever invoking the compiler", async () => {
    const dir = await temp();
    const prebuiltRoot = join(dir, "prebuilt");
    await mkdir(prebuiltRoot, { recursive: true });
    await writeFile(join(prebuiltRoot, "p.so"), "prebuilt bytes");
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update("prebuilt bytes").digest("hex");
    await writeFile(
      join(prebuiltRoot, "manifest.json"),
      JSON.stringify({ builds: [{ kwinVersion: "6.7.3", arch: "x64", file: "p.so", sha256 }] }),
    );

    let built = false;
    const deps = await baseDeps({
      prebuiltRoot,
      buildFromSource: async () => {
        built = true;
        return "unused";
      },
    });
    const result = await provisionKWinPlugin(deps);

    expect(result.action).toBe("installed-prebuilt");
    expect(built).toBe(false);
    expect(
      await readFile(join(deps.target.pluginDirectory, "SynaraComputerUsePluginV1.so"), "utf8"),
    ).toBe("prebuilt bytes");
  });

  it("builds from source when no prebuilt matches this KWin", async () => {
    const deps = await baseDeps({ kwinVersion: async () => "6.9.9" });
    const result = await provisionKWinPlugin(deps);

    expect(result.action).toBe("installed-from-source");
    expect(
      await readFile(join(deps.target.pluginDirectory, "SynaraComputerUsePluginV1.so"), "utf8"),
    ).toBe("from source");
  });

  it("refuses a prebuilt whose bytes do not match the manifest", async () => {
    const dir = await temp();
    const prebuiltRoot = join(dir, "prebuilt");
    await mkdir(prebuiltRoot, { recursive: true });
    await writeFile(join(prebuiltRoot, "p.so"), "tampered");
    await writeFile(
      join(prebuiltRoot, "manifest.json"),
      JSON.stringify({
        builds: [
          {
            kwinVersion: "6.7.3",
            arch: "x64",
            file: "p.so",
            // Well-formed but wrong: this is the mismatch case, not the
            // malformed-entry case.
            sha256: "0".repeat(64),
          },
        ],
      }),
    );

    // Not silently downgraded to a source build: a checksum failure means the
    // shipped file is wrong, and that is worth stopping over.
    await expect(provisionKWinPlugin(await baseDeps({ prebuiltRoot }))).rejects.toThrow(
      /failed its checksum/,
    );
  });

  it("says a login is needed only when the running session cannot see the directory", async () => {
    const deps = await baseDeps();
    const first = await provisionKWinPlugin(deps);
    expect(first.requiresRelogin).toBe(true);
    expect(first.summary).toMatch(/Log out and back in/);

    const seen = await provisionKWinPlugin({
      ...deps,
      env: { ...deps.env, QT_PLUGIN_PATH: deps.target.qtPluginRoot },
    });
    expect(seen.requiresRelogin).toBe(false);
    expect(seen.summary).not.toMatch(/Log out/);
  });

  it("writes the env script even when the plugin is already current", async () => {
    const deps = await baseDeps({ isCurrent: async () => true });
    const result = await provisionKWinPlugin(deps);

    expect(result.action).toBe("already-current");
    expect(result.pluginId).toBeUndefined();
    // The script is what makes any install visible at all, so a user who deleted
    // it gets it back on the next enable rather than a plugin KWin never scans.
    expect(await readFile(envScriptPath(deps.env, "/unused"), "utf8")).toContain(
      deps.target.qtPluginRoot,
    );
  });

  it("still asks for the login when a current install is one the session cannot see", async () => {
    const seen = await provisionKWinPlugin(
      await baseDeps({
        isCurrent: async () => true,
        env: { XDG_CONFIG_HOME: (await temp()) + "/config", QT_PLUGIN_PATH: "/tmp/elsewhere" },
      }),
    );
    expect(seen.requiresRelogin).toBe(true);
    expect(seen.summary).toMatch(/installed and current\. Log out/);

    const deps = await baseDeps({ isCurrent: async () => true });
    const visible = await provisionKWinPlugin({
      ...deps,
      env: { ...deps.env, QT_PLUGIN_PATH: deps.target.qtPluginRoot },
    });
    expect(visible.requiresRelogin).toBe(false);
    expect(visible.summary).not.toMatch(/Log out/);
  });

  it("reinstalls past a current stamp when forced, which is what a refusal needs", async () => {
    let built = 0;
    const deps = await baseDeps({
      isCurrent: async () => true,
      buildFromSource: async () => {
        built += 1;
        const built_so = join(deps.target.pluginDirectory, "..", "built.so");
        await mkdir(join(deps.target.pluginDirectory, ".."), { recursive: true });
        await writeFile(built_so, "rebuilt");
        return built_so;
      },
    });
    const result = await provisionKWinPlugin({ ...deps, force: true });

    expect(result.action).toBe("installed-from-source");
    expect(result.pluginId).toBe("SynaraComputerUsePluginV1");
    expect(built).toBe(1);
  });

  it("records the KWin version it installed for, so a later refusal can name it", async () => {
    const deps = await baseDeps();
    await provisionKWinPlugin(deps);
    const stamp = await readFile(deps.stampPath, "utf8");

    expect(stamp).toContain("plugin_id=SynaraComputerUsePluginV1");
    expect(stamp).toContain("kwin_version=6.7.3");
    // Absent on purpose: the shell installer treats a missing signature as
    // "rebuild", which is the right answer for a stamp it did not write.
    expect(stamp).not.toContain("signature=");
  });

  it("deletes the build it supersedes, which would otherwise auto-load and win the bus name", async () => {
    const deps = await baseDeps();
    await mkdir(deps.target.pluginDirectory, { recursive: true });
    await writeFile(join(deps.target.pluginDirectory, "SynaraComputerUsePluginV4.so"), "old");
    await writeFile(join(deps.target.pluginDirectory, "keep-me.txt"), "unrelated");

    const result = await provisionKWinPlugin({
      ...deps,
      listInstalled: async () => ["SynaraComputerUsePluginV4.so"],
    });

    expect(result.pluginId).toBe("SynaraComputerUsePluginV5");
    const remaining = await readdir(deps.target.pluginDirectory);
    expect(remaining.toSorted()).toEqual(
      ["SynaraComputerUsePluginV5.so", "keep-me.txt"].toSorted(),
    );
  });

  it("keeps the version suffix climbing past what is already installed", async () => {
    const deps = await baseDeps({
      listInstalled: async () => ["SynaraComputerUsePluginV4.so"],
    });
    const result = await provisionKWinPlugin(deps);
    expect(result.pluginId).toBe("SynaraComputerUsePluginV5");
  });
});

describe("prune", () => {
  it("survives a directory that does not exist yet", async () => {
    const dir = await temp();
    expect(await pruneSupersededPlugins(join(dir, "absent"), "SynaraComputerUsePluginV1")).toEqual(
      [],
    );
  });
});

describe("installed binary", () => {
  it("is executable and named for its id", async () => {
    const dir = await temp();
    const source = join(dir, "src.so");
    await writeFile(source, "bytes");
    const destination = await installPluginBinary(
      source,
      join(dir, "a", "b"),
      "SynaraComputerUsePluginV9",
    );
    expect(destination).toBe(join(dir, "a", "b", "SynaraComputerUsePluginV9.so"));
    expect((await stat(destination)).mode & 0o111).toBeTruthy();
  });
});
