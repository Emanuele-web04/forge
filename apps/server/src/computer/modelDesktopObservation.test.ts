import { describe, expect, it } from "vitest";

import {
  isModelDesktopObservationActive,
  withModelDesktopObservation,
} from "./modelDesktopObservation.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("model desktop observation scope", () => {
  it("isolates concurrent scopes and leaves outside work inactive", async () => {
    expect(isModelDesktopObservationActive()).toBe(false);
    const firstRelease = deferred();
    const secondRelease = deferred();
    const first = withModelDesktopObservation(async () => {
      expect(isModelDesktopObservationActive()).toBe(true);
      await firstRelease.promise;
      expect(isModelDesktopObservationActive()).toBe(true);
      return "first observation";
    });
    const second = withModelDesktopObservation(async () => {
      expect(isModelDesktopObservationActive()).toBe(true);
      await secondRelease.promise;
      expect(isModelDesktopObservationActive()).toBe(true);
    });
    expect(isModelDesktopObservationActive()).toBe(false);
    firstRelease.resolve();
    expect(await first).toBe("first observation");
    expect(isModelDesktopObservationActive()).toBe(false);
    secondRelease.resolve();
    await second;
    expect(isModelDesktopObservationActive()).toBe(false);
  });

  it("expires authority in an inherited continuation after completion", async () => {
    const release = deferred();
    let delayed!: Promise<boolean>;
    await withModelDesktopObservation(async () => {
      delayed = release.promise.then(isModelDesktopObservationActive);
      expect(isModelDesktopObservationActive()).toBe(true);
    });
    release.resolve();
    expect(await delayed).toBe(false);
  });

  it.each(["synchronous throw", "rejected promise"] as const)(
    "expires inherited authority after a %s",
    async (failureMode) => {
      const release = deferred();
      const failure = new Error("observation failed");
      let delayed!: Promise<boolean>;
      const result = withModelDesktopObservation(() => {
        delayed = release.promise.then(isModelDesktopObservationActive);
        expect(isModelDesktopObservationActive()).toBe(true);
        if (failureMode === "synchronous throw") throw failure;
        return Promise.reject(failure);
      });
      await expect(result).rejects.toBe(failure);
      expect(isModelDesktopObservationActive()).toBe(false);
      release.resolve();
      expect(await delayed).toBe(false);
    },
  );

  it("restores the outer scope while expiring a completed nested scope", async () => {
    const release = deferred();
    let delayed!: Promise<boolean>;
    await withModelDesktopObservation(async () => {
      await withModelDesktopObservation(async () => {
        delayed = release.promise.then(isModelDesktopObservationActive);
        expect(isModelDesktopObservationActive()).toBe(true);
      });
      expect(isModelDesktopObservationActive()).toBe(true);
      release.resolve();
      expect(await delayed).toBe(false);
      expect(isModelDesktopObservationActive()).toBe(true);
    });
    expect(isModelDesktopObservationActive()).toBe(false);
  });
});
