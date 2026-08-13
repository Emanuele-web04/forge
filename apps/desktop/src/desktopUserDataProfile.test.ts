import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  repairBrowserProfileFromBridgeManifest,
  resolveDesktopAppDataBase,
  resolveDesktopUserDataPath,
} from "./desktopUserDataProfile";

const tempDirs = new Set<string>();

function makeTempDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-profile-test-"));
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("desktopUserDataProfile", () => {
  it("resolves the canonical Synara profile names", () => {
    const appDataBase = "/Users/tester/Library/Application Support";
    expect(resolveDesktopUserDataPath({ appDataBase, userDataDirectoryName: "synara-dev" })).toBe(
      "/Users/tester/Library/Application Support/synara-dev",
    );
    expect(resolveDesktopUserDataPath({ appDataBase, userDataDirectoryName: "synara" })).toBe(
      "/Users/tester/Library/Application Support/synara",
    );
    expect(
      resolveDesktopUserDataPath({ appDataBase, userDataDirectoryName: "synara-canary" }),
    ).toBe("/Users/tester/Library/Application Support/synara-canary");
  });

  it("uses XDG_CONFIG_HOME on Linux when available", () => {
    expect(
      resolveDesktopAppDataBase({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/tmp/xdg" },
        homeDir: "/home/tester",
      }),
    ).toBe("/tmp/xdg");
  });

  it("repairs missing browser data from the profile recorded by the bridge", () => {
    const appDataBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "synara");
    const sourcePath = Path.join(appDataBase, "previous-profile");
    const sourcePartitionPath = Path.join(sourcePath, "Partitions", "previous-browser");
    const targetPartitionPath = Path.join(targetPath, "Partitions", "synara-browser");
    FS.mkdirSync(Path.join(sourcePartitionPath, "Local Storage"), { recursive: true });
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies"), "bridge-cookie");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies-journal"), "bridge-journal");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Local Storage", "state"), "bridge-state");
    FS.mkdirSync(Path.join(targetPartitionPath, "Local Storage"), { recursive: true });
    FS.writeFileSync(Path.join(targetPartitionPath, "Local Storage", "state"), "current-state");
    FS.writeFileSync(
      Path.join(targetPath, "synara-profile-seed.json"),
      JSON.stringify({ sourcePath }),
    );

    const result = repairBrowserProfileFromBridgeManifest(targetPath);

    expect(result).toMatchObject({
      status: "repaired",
      sourcePath,
      targetPath,
      copiedEntries: ["Cookies", "Cookies-journal"],
    });
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies"), "utf8")).toBe(
      "bridge-cookie",
    );
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies-journal"), "utf8")).toBe(
      "bridge-journal",
    );
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Local Storage", "state"), "utf8")).toBe(
      "current-state",
    );
  });

  it("rejects bridge manifests that point outside the Synara profile parent", () => {
    const appDataBase = makeTempDir();
    const unrelatedBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "synara");
    FS.mkdirSync(targetPath, { recursive: true });
    FS.writeFileSync(
      Path.join(targetPath, "synara-profile-seed.json"),
      JSON.stringify({ sourcePath: Path.join(unrelatedBase, "previous-profile") }),
    );

    expect(repairBrowserProfileFromBridgeManifest(targetPath)).toMatchObject({
      status: "bridge-unavailable",
      sourcePath: null,
      copiedEntries: [],
    });
  });

  it("never adds a foreign SQLite sidecar beside an existing Synara database", () => {
    const appDataBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "synara");
    const sourcePath = Path.join(appDataBase, "previous-profile");
    const sourcePartitionPath = Path.join(sourcePath, "Partitions", "previous-browser");
    const targetPartitionPath = Path.join(targetPath, "Partitions", "synara-browser");
    FS.mkdirSync(sourcePartitionPath, { recursive: true });
    FS.mkdirSync(targetPartitionPath, { recursive: true });
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies"), "bridge-cookie");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies-journal"), "bridge-journal");
    FS.writeFileSync(Path.join(targetPartitionPath, "Cookies"), "current-cookie");
    FS.writeFileSync(
      Path.join(targetPath, "synara-profile-seed.json"),
      JSON.stringify({ sourcePath }),
    );

    expect(repairBrowserProfileFromBridgeManifest(targetPath)).toMatchObject({
      status: "not-needed",
      copiedEntries: [],
    });
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies"), "utf8")).toBe(
      "current-cookie",
    );
    expect(FS.existsSync(Path.join(targetPartitionPath, "Cookies-journal"))).toBe(false);
  });

  it("replaces an orphaned target sidecar with one from the repaired database generation", () => {
    const appDataBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "synara");
    const sourcePath = Path.join(appDataBase, "previous-profile");
    const sourcePartitionPath = Path.join(sourcePath, "Partitions", "previous-browser");
    const targetPartitionPath = Path.join(targetPath, "Partitions", "synara-browser");
    FS.mkdirSync(sourcePartitionPath, { recursive: true });
    FS.mkdirSync(targetPartitionPath, { recursive: true });
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies"), "bridge-cookie");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies-journal"), "bridge-journal");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies-wal"), "bridge-wal");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies-shm"), "bridge-shm");
    FS.writeFileSync(Path.join(targetPartitionPath, "Cookies-journal"), "orphaned-journal");
    FS.writeFileSync(Path.join(targetPartitionPath, "Cookies-wal"), "orphaned-wal");
    FS.writeFileSync(Path.join(targetPartitionPath, "Cookies-shm"), "orphaned-shm");
    FS.writeFileSync(
      Path.join(targetPath, "synara-profile-seed.json"),
      JSON.stringify({ sourcePath }),
    );

    expect(repairBrowserProfileFromBridgeManifest(targetPath)).toMatchObject({
      status: "repaired",
      copiedEntries: ["Cookies", "Cookies-journal", "Cookies-wal", "Cookies-shm"],
    });
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies"), "utf8")).toBe(
      "bridge-cookie",
    );
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies-journal"), "utf8")).toBe(
      "bridge-journal",
    );
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies-wal"), "utf8")).toBe(
      "bridge-wal",
    );
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies-shm"), "utf8")).toBe(
      "bridge-shm",
    );
    expect(
      FS.readdirSync(targetPartitionPath).some((entryName) =>
        entryName.startsWith(".synara-bridge-"),
      ),
    ).toBe(false);
  });

  it("copies from only the newest browser partition recorded under the bridge profile", () => {
    const appDataBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "synara");
    const sourcePath = Path.join(appDataBase, "previous-profile");
    const olderPartitionPath = Path.join(sourcePath, "Partitions", "older-browser");
    const newerPartitionPath = Path.join(sourcePath, "Partitions", "newer-browser");
    FS.mkdirSync(Path.join(olderPartitionPath, "Local Storage"), { recursive: true });
    FS.mkdirSync(newerPartitionPath, { recursive: true });
    FS.writeFileSync(Path.join(olderPartitionPath, "Cookies"), "older-cookie");
    FS.writeFileSync(Path.join(olderPartitionPath, "Local Storage", "state"), "older-state");
    FS.writeFileSync(Path.join(newerPartitionPath, "Cookies"), "newer-cookie");
    FS.utimesSync(olderPartitionPath, new Date(1_000), new Date(1_000));
    FS.utimesSync(newerPartitionPath, new Date(2_000), new Date(2_000));
    FS.mkdirSync(targetPath, { recursive: true });
    FS.writeFileSync(
      Path.join(targetPath, "synara-profile-seed.json"),
      JSON.stringify({ sourcePath }),
    );

    const result = repairBrowserProfileFromBridgeManifest(targetPath);
    const targetPartitionPath = Path.join(targetPath, "Partitions", "synara-browser");

    expect(result).toMatchObject({ status: "repaired", copiedEntries: ["Cookies"] });
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies"), "utf8")).toBe("newer-cookie");
    expect(FS.existsSync(Path.join(targetPartitionPath, "Local Storage"))).toBe(false);
  });

  it("ignores a malformed bridge manifest without attempting a repair", () => {
    const appDataBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "synara");
    FS.mkdirSync(targetPath, { recursive: true });
    FS.writeFileSync(Path.join(targetPath, "synara-profile-seed.json"), "{");

    expect(repairBrowserProfileFromBridgeManifest(targetPath)).toMatchObject({
      status: "bridge-unavailable",
      sourcePath: null,
      copiedEntries: [],
    });
  });
});
