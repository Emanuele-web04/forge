import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveOutOfRootFileReference } from "./outOfRootFileReference";

describe("resolveOutOfRootFileReference", () => {
  let homeDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-out-of-root-"));
    workspaceRoot = path.join(homeDir, "Documents", "Claude", "Skills");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const writeFile = (fullPath: string, contents = "contents") => {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
  };

  it("relocates a reference that resolves under an ancestor of the workspace root", async () => {
    const actualPath = path.join(homeDir, "Documents", "Claude", "Outbox", "Content", "note.md");
    writeFile(actualPath);

    const resolved = await resolveOutOfRootFileReference({
      workspaceRoot,
      relativePath: "Claude/Outbox/Content/note.md",
      homeDir,
    });

    expect(resolved).toBe(fs.realpathSync(actualPath));
  });

  it("prefers the nearest ancestor when several candidates exist", async () => {
    const nearPath = path.join(homeDir, "Documents", "Claude", "shared", "note.md");
    const farPath = path.join(homeDir, "shared", "note.md");
    writeFile(nearPath, "near");
    writeFile(farPath, "far");

    const resolved = await resolveOutOfRootFileReference({
      workspaceRoot,
      relativePath: "shared/note.md",
      homeDir,
    });

    expect(resolved).toBe(fs.realpathSync(nearPath));
  });

  it("returns null when the reference exists inside the workspace root", async () => {
    writeFile(path.join(workspaceRoot, "shared", "note.md"));
    writeFile(path.join(homeDir, "shared", "note.md"));

    const resolved = await resolveOutOfRootFileReference({
      workspaceRoot,
      relativePath: "shared/note.md",
      homeDir,
    });

    expect(resolved).toBeNull();
  });

  it("returns null when the in-root path exists as a directory", async () => {
    fs.mkdirSync(path.join(workspaceRoot, "shared", "note.md"), { recursive: true });
    writeFile(path.join(homeDir, "shared", "note.md"));

    const resolved = await resolveOutOfRootFileReference({
      workspaceRoot,
      relativePath: "shared/note.md",
      homeDir,
    });

    expect(resolved).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "does not relocate when the in-root stat fails for a non-missing reason",
    async () => {
      const inRootPath = path.join(workspaceRoot, "shared", "note.md");
      fs.mkdirSync(path.dirname(inRootPath), { recursive: true });
      fs.symlinkSync(inRootPath, inRootPath);
      writeFile(path.join(homeDir, "Documents", "Claude", "shared", "note.md"));

      const resolved = await resolveOutOfRootFileReference({
        workspaceRoot,
        relativePath: "shared/note.md",
        homeDir,
      });

      expect(resolved).toBeNull();
    },
  );

  it("returns null when no ancestor candidate exists", async () => {
    const resolved = await resolveOutOfRootFileReference({
      workspaceRoot,
      relativePath: "missing/nowhere.md",
      homeDir,
    });

    expect(resolved).toBeNull();
  });

  it("skips ancestor candidates that are directories", async () => {
    fs.mkdirSync(path.join(homeDir, "Documents", "Claude", "shared", "note.md"), {
      recursive: true,
    });

    const resolved = await resolveOutOfRootFileReference({
      workspaceRoot,
      relativePath: "shared/note.md",
      homeDir,
    });

    expect(resolved).toBeNull();
  });

  it("rejects unsafe relative paths", async () => {
    writeFile(path.join(homeDir, "Documents", "secret.md"));

    for (const relativePath of [
      "../secret.md",
      "..\\secret.md",
      "/etc/passwd",
      "Documents/./secret.md",
      "Documents/..",
    ]) {
      expect(
        await resolveOutOfRootFileReference({ workspaceRoot, relativePath, homeDir }),
      ).toBeNull();
    }
  });

  it("never walks above the home directory", async () => {
    // A root directly under home has only home itself as an in-home ancestor.
    const shallowRoot = path.join(homeDir, "workspace");
    fs.mkdirSync(shallowRoot, { recursive: true });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-outside-home-"));
    try {
      writeFile(path.join(outsideDir, "escape.md"));

      const resolved = await resolveOutOfRootFileReference({
        workspaceRoot: shallowRoot,
        relativePath: `${path.basename(outsideDir)}/escape.md`,
        homeDir,
      });

      expect(resolved).toBeNull();
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("returns null when the workspace root lives outside the home directory", async () => {
    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synara-foreign-root-"));
    try {
      const resolved = await resolveOutOfRootFileReference({
        workspaceRoot: foreignRoot,
        relativePath: "shared/note.md",
        homeDir,
      });

      expect(resolved).toBeNull();
    } finally {
      fs.rmSync(foreignRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlinked candidates that escape the home directory",
    async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-symlink-escape-"));
      try {
        writeFile(path.join(outsideDir, "escape.md"));
        fs.mkdirSync(path.join(homeDir, "Documents", "Claude", "shared"), { recursive: true });
        fs.symlinkSync(
          path.join(outsideDir, "escape.md"),
          path.join(homeDir, "Documents", "Claude", "shared", "note.md"),
        );

        const resolved = await resolveOutOfRootFileReference({
          workspaceRoot,
          relativePath: "shared/note.md",
          homeDir,
        });

        expect(resolved).toBeNull();
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );
});
