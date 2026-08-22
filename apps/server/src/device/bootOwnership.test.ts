import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { makeBootOwnershipStore, orphanedBootUdids, processIsAlive } from "./bootOwnership.ts";

const store = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "synara-boot-own-"));
  return { dir, file: path.join(dir, "ownership.json") };
};

describe("the boot ownership record", () => {
  it("survives the process that wrote it", async () => {
    // The whole point: a crash runs no finalizer, so the only way the next run
    // can know which simulators were ours is to have written it down.
    const { file } = await store();
    await makeBootOwnershipStore(file, 4242).write(["A", "B"]);

    const read = await makeBootOwnershipStore(file, 9999).read();

    expect(read).toEqual({ pid: 4242, udids: ["A", "B"] });
  });

  it("reads as owning nothing when the file is absent or corrupt", async () => {
    // Shutting down a device we cannot prove is ours is worse than leaking one,
    // so every unreadable state degrades to "own nothing".
    const { dir, file } = await store();
    expect(await makeBootOwnershipStore(file).read()).toBeNull();

    const corrupt = path.join(dir, "corrupt.json");
    await writeFile(corrupt, "{ not json", "utf8");
    expect(await makeBootOwnershipStore(corrupt).read()).toBeNull();

    const wrongVersion = path.join(dir, "v2.json");
    await writeFile(wrongVersion, JSON.stringify({ version: 2, udids: ["A"] }), "utf8");
    expect(await makeBootOwnershipStore(wrongVersion).read()).toBeNull();
  });

  it("clears to an empty list rather than deleting the file", async () => {
    const { file } = await store();
    const owned = makeBootOwnershipStore(file, 7);
    await owned.write(["A"]);
    await owned.clear();

    expect((await owned.read())?.udids).toEqual([]);
    // Still valid JSON, so the next read is a clean empty rather than a parse
    // failure that looks identical to corruption.
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, udids: [] });
  });
});

describe("deciding which boots to reclaim", () => {
  const dead = () => false;
  const alive = () => true;

  it("reclaims devices a dead process left booted", async () => {
    expect(orphanedBootUdids({ pid: 123, udids: ["A", "B"] }, ["A", "B"], dead)).toEqual([
      "A",
      "B",
    ]);
  });

  it("leaves a live sibling server's devices alone", () => {
    // Two Synara processes can run at once; the older record belongs to the
    // one still running, and shutting its simulators down would be a bug.
    expect(orphanedBootUdids({ pid: 123, udids: ["A"] }, ["A"], alive)).toEqual([]);
  });

  it("never reclaims a device the user booted themselves", () => {
    // The safety property that matters most: only udids we recorded are
    // candidates, so anything else running stays running.
    expect(orphanedBootUdids({ pid: 9, udids: ["OURS"] }, ["OURS", "THEIRS"], dead)).toEqual([
      "OURS",
    ]);
  });

  it("ignores recorded devices that are already shut down", () => {
    expect(orphanedBootUdids({ pid: 9, udids: ["A"] }, [], dead)).toEqual([]);
  });

  it("does nothing without a record", () => {
    expect(orphanedBootUdids(null, ["A"], dead)).toEqual([]);
    expect(orphanedBootUdids({ pid: 9, udids: [] }, ["A"], dead)).toEqual([]);
  });
});

describe("processIsAlive", () => {
  it("recognises this very process", () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it("reports a pid that cannot exist as dead", () => {
    // Above the usual pid_max, so it is safe to assume nothing owns it.
    expect(processIsAlive(0x7fffffff)).toBe(false);
  });
});
