import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapArtifactSearchPaths,
  resolveBootstrapArtifactSet,
} from "./bootstrapArtifactSource";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "synara-artifact-source-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("bootstrapArtifactSearchPaths", () => {
  it("puts an explicit override ahead of the packaged locations", () => {
    // The override is the only way to exercise this path outside a packaged
    // build, so it has to win against a manifest that happens to be bundled.
    const paths = bootstrapArtifactSearchPaths({
      target: "linux-x64",
      moduleDirectory: "/app/server",
      overrideDirectory: "/tmp/local-release",
    });
    expect(paths[0]).toBe("/tmp/local-release/bootstrap-artifacts-linux-x64.json");
  });

  it("names the manifest per target so architectures cannot be confused", () => {
    const [x64] = bootstrapArtifactSearchPaths({
      target: "linux-x64",
      moduleDirectory: "/app/server",
    });
    const [arm64] = bootstrapArtifactSearchPaths({
      target: "linux-arm64",
      moduleDirectory: "/app/server",
    });
    expect(x64).not.toBe(arm64);
  });
});

describe("resolveBootstrapArtifactSet", () => {
  it("reports absence as data, listing where it looked", async () => {
    // THE DEV-CHECKOUT CASE. A throw here would crash-loop the supervisor on
    // every machine this feature is developed on, so absence must be a value —
    // and it has to say where it looked, or "install a release build" is not
    // actionable.
    const availability = await resolveBootstrapArtifactSet({
      target: "linux-x64",
      moduleDirectory: workspace,
    });
    expect(availability.available).toBe(false);
    if (availability.available) throw new Error("expected artifacts to be unavailable");
    expect(availability.reason).toContain("linux-x64");
    expect(availability.searched.length).toBeGreaterThan(0);
  });

  it("throws for a manifest that exists but is corrupt", async () => {
    // Absence is a normal dev state; corruption is a real fault. Reporting a
    // broken release as "no artifacts" would hide it behind a message that
    // tells the maintainer to do something they have already done.
    await writeFile(join(workspace, "bootstrap-artifacts-linux-x64.json"), "{ not json");
    await expect(
      resolveBootstrapArtifactSet({ target: "linux-x64", moduleDirectory: workspace }),
    ).rejects.toThrow(/manifest/i);
  });
});
