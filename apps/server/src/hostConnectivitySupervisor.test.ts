// The supervisor follows the credentials file: no link means nothing runs, a
// link starts connectivity, a changed link restarts it, an unlink stops it,
// and rewrites that leave the link alone (token refresh) are ignored.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeAccountCredentials, type StoredAccountFile } from "./accountAuth";
import { hostLinkKey, superviseHostConnectivity } from "./hostConnectivitySupervisor";

const BASE: StoredAccountFile = {
  accountUrl: "https://api.example.test",
  workosClientId: "client",
  workosApiUrl: "https://workos.example.test",
  organizationId: "org_1",
  userId: "user_1",
  accessToken: "access",
  refreshToken: "refresh",
};

const LINKED: StoredAccountFile = {
  ...BASE,
  hostId: "host_1",
  hostOwnerUserId: "user_1",
  hostKeyGeneration: 1,
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-connectivity-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function harness() {
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const start = vi.fn(async () => {
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  return { start, stops };
}

describe("hostLinkKey", () => {
  it("is undefined until every host field is present", () => {
    expect(hostLinkKey(undefined)).toBeUndefined();
    expect(hostLinkKey(BASE)).toBeUndefined();
    const { hostKeyGeneration: _generation, ...withoutGeneration } = LINKED;
    expect(hostLinkKey(withoutGeneration)).toBeUndefined();
    expect(hostLinkKey(LINKED)).toBeDefined();
  });

  it("ignores session rotation but changes with the key generation", () => {
    expect(hostLinkKey({ ...LINKED, accessToken: "other", refreshToken: "other" })).toBe(
      hostLinkKey(LINKED),
    );
    expect(hostLinkKey({ ...LINKED, hostKeyGeneration: 2 })).not.toBe(hostLinkKey(LINKED));
  });
});

describe("superviseHostConnectivity", () => {
  it("starts nothing without a link and starts once the link is written", async () => {
    const dir = await tempDir();
    const { start, stops } = harness();
    const supervisor = await superviseHostConnectivity({ baseDir: dir, start, debounceMs: 20 });
    cleanups.push(() => supervisor.stop());
    expect(start).not.toHaveBeenCalled();

    await writeAccountCredentials(dir, BASE);
    await supervisor.reconcile();
    expect(start).not.toHaveBeenCalled();

    await writeAccountCredentials(dir, LINKED);
    await until(() => start.mock.calls.length === 1);
    expect(stops[0]).not.toHaveBeenCalled();
  });

  it("restarts on a new key generation, ignores a token refresh, stops on unlink", async () => {
    const dir = await tempDir();
    await writeAccountCredentials(dir, LINKED);
    const { start, stops } = harness();
    const supervisor = await superviseHostConnectivity({ baseDir: dir, start, debounceMs: 20 });
    cleanups.push(() => supervisor.stop());
    expect(start).toHaveBeenCalledTimes(1);

    await writeAccountCredentials(dir, { ...LINKED, accessToken: "rotated" });
    await supervisor.reconcile();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stops[0]).not.toHaveBeenCalled();

    await writeAccountCredentials(dir, { ...LINKED, hostKeyGeneration: 2 });
    await until(() => start.mock.calls.length === 2);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();

    const { hostId: _h, hostOwnerUserId: _o, hostKeyGeneration: _g, ...unlinked } = LINKED;
    await writeAccountCredentials(dir, unlinked);
    await until(() => stops[1]!.mock.calls.length === 1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("retries a failed start on the next reconcile and stops the active one on stop()", async () => {
    const dir = await tempDir();
    await writeAccountCredentials(dir, LINKED);
    const stop = vi.fn();
    const start = vi
      .fn<() => Promise<() => void>>()
      .mockRejectedValueOnce(new Error("api down"))
      .mockResolvedValue(stop);
    const supervisor = await superviseHostConnectivity({ baseDir: dir, start, debounceMs: 20 });
    expect(start).toHaveBeenCalledTimes(1);

    await supervisor.reconcile();
    expect(start).toHaveBeenCalledTimes(2);

    supervisor.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    // Stopped supervisors ignore later changes.
    await writeAccountCredentials(dir, { ...LINKED, hostKeyGeneration: 3 });
    await supervisor.reconcile();
    expect(start).toHaveBeenCalledTimes(2);
  });
});
