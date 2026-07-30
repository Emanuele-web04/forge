import { describe, expect, it } from "vitest";

import {
  assertSafeInstallRoot,
  isPathInsideInstallRoot,
  remoteInstallLayout,
  remoteReleaseDirectory,
} from "./remoteInstallLayout";

const layout = remoteInstallLayout("/home/deploy/.synara/remote");

describe("assertSafeInstallRoot", () => {
  it.each([
    ["/", "the filesystem root"],
    ["/usr", "a system directory"],
    ["/usr/local", "a system directory"],
    ["/etc", "a system directory"],
    ["/var", "a system directory"],
    ["/tmp", "a shared temp directory"],
    ["/opt", "a system directory"],
    ["/root", "the root home directory"],
    ["/home", "the home parent"],
    ["/Users", "the macOS home parent"],
  ])("refuses %s (%s)", (root) => {
    expect(() => assertSafeInstallRoot(root)).toThrow(/Refusing to manage/);
  });

  // Mutation guard: removing the "home directory root" depth check would make
  // uninstall `rm -rf` a user's entire home directory.
  it.each(["/home/alice", "/Users/alice", "/home/alice/"])(
    "refuses the whole home directory %s",
    (root) => {
      expect(() => assertSafeInstallRoot(root)).toThrow(/home directory root/);
    },
  );

  it("accepts a subdirectory of a home directory", () => {
    expect(assertSafeInstallRoot("/home/alice/.synara")).toBe("/home/alice/.synara");
    expect(assertSafeInstallRoot("/Users/alice/.synara/remote")).toBe(
      "/Users/alice/.synara/remote",
    );
  });

  it("refuses a relative root", () => {
    expect(() => assertSafeInstallRoot(".synara")).toThrow(/absolute POSIX path/);
    expect(() => assertSafeInstallRoot("~/synara")).toThrow(/absolute POSIX path/);
  });

  it("refuses traversal segments", () => {
    expect(() => assertSafeInstallRoot("/home/alice/../../etc")).toThrow(/relative segments/);
    expect(() => assertSafeInstallRoot("/home/alice/./synara")).toThrow(/relative segments/);
  });

  it("refuses NUL and newline injection into a path", () => {
    expect(() => assertSafeInstallRoot("/home/alice/syn\nara")).toThrow(/illegal characters/);
    expect(() => assertSafeInstallRoot("/home/alice/syn\0ara")).toThrow(/illegal characters/);
  });

  it("normalizes redundant separators and trailing slashes", () => {
    expect(assertSafeInstallRoot("/home//alice///.synara/")).toBe("/home/alice/.synara");
  });
});

describe("layout derivation", () => {
  it("roots every managed path under the install root", () => {
    for (const value of Object.values(layout)) {
      expect(isPathInsideInstallRoot(layout, value)).toBe(true);
    }
  });

  it("keeps the credential inside the private state directory", () => {
    expect(layout.credentialFile.startsWith(`${layout.stateDirectory}/`)).toBe(true);
  });
});

describe("isPathInsideInstallRoot", () => {
  it("accepts the root itself and descendants", () => {
    expect(isPathInsideInstallRoot(layout, layout.root)).toBe(true);
    expect(isPathInsideInstallRoot(layout, `${layout.root}/releases/1.2.3`)).toBe(true);
  });

  // Mutation guard: a naive `startsWith(root)` without the separator would
  // accept this sibling directory and delete it.
  it("rejects a sibling directory that shares the root's prefix", () => {
    expect(isPathInsideInstallRoot(layout, `${layout.root}-backup`)).toBe(false);
  });

  it("rejects an escape through traversal", () => {
    expect(isPathInsideInstallRoot(layout, `${layout.root}/../../etc`)).toBe(false);
  });

  it("rejects unrelated absolute paths and relative paths", () => {
    expect(isPathInsideInstallRoot(layout, "/etc/passwd")).toBe(false);
    expect(isPathInsideInstallRoot(layout, "releases/1.0.0")).toBe(false);
  });
});

describe("remoteReleaseDirectory", () => {
  it("places a valid release under releases/", () => {
    expect(remoteReleaseDirectory(layout, "0.6.3")).toBe(`${layout.releasesDirectory}/0.6.3`);
  });

  // Mutation guard: dropping normalizeReleaseId here re-opens path traversal
  // out of the install root through a crafted release id.
  it.each(["../../etc", "..", "a/b", "a\nb", "a%b", ""])("refuses release id %j", (releaseId) => {
    expect(() => remoteReleaseDirectory(layout, releaseId)).toThrow(/Invalid remote release id/);
  });

  it("keeps any accepted release id inside the root", () => {
    for (const releaseId of ["0.6.3", "1.0.0-rc.1", "v2_0", "abc123"]) {
      expect(isPathInsideInstallRoot(layout, remoteReleaseDirectory(layout, releaseId))).toBe(true);
    }
  });
});
