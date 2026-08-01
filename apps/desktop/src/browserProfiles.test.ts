import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserProfileStore,
  PERSONAL_BROWSER_PROFILE_ID,
  TEMPORARY_BROWSER_PROFILE_ID,
} from "./browserProfiles";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("BrowserProfileStore", () => {
  it("keeps separate persistent identities and durable thread bindings", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-browser-profiles-"));
    temporaryDirectories.push(directory);
    const storagePath = Path.join(directory, "browser-profiles.json");
    const store = new BrowserProfileStore({
      storagePath,
      createId: () => "e7a0a2ef-5a6d-4f70-a15d-7e6d3b27a1a9",
    });

    expect(store.profileForThread("thread-a").id).toBe(TEMPORARY_BROWSER_PROFILE_ID);
    expect(store.list("thread-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: PERSONAL_BROWSER_PROFILE_ID,
          partition: "persist:synara-browser",
        }),
        expect.objectContaining({
          id: TEMPORARY_BROWSER_PROFILE_ID,
          kind: "temporary",
          partition: expect.stringMatching(/^synara-browser-temporary-[a-f0-9]{24}$/),
        }),
      ]),
    );

    const work = store.create("Work");
    expect(work.partition).toBe(
      "persist:synara-browser-profile-e7a0a2ef-5a6d-4f70-a15d-7e6d3b27a1a9",
    );
    store.bindThread("thread-a", work.id);

    const restartedStore = new BrowserProfileStore({ storagePath });
    expect(restartedStore.profileForThread("thread-a")).toMatchObject({
      id: work.id,
      label: "Work",
      partition: work.partition,
    });
    expect(FS.statSync(storagePath).mode & 0o777).toBe(0o600);
  });

  it("quarantines an unreadable store instead of overwriting it", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-browser-profiles-"));
    temporaryDirectories.push(directory);
    const storagePath = Path.join(directory, "browser-profiles.json");
    FS.writeFileSync(storagePath, '{"version":1,"profiles":[{"id":"work-', "utf8");

    const store = new BrowserProfileStore({
      storagePath,
      createId: () => "b1d1a5e3-1f3c-4b0e-9a2a-2f5f0b8c7d61",
    });
    store.create("Work");

    const quarantined = FS.readdirSync(directory).filter((entry) =>
      entry.startsWith("browser-profiles.json.corrupt-"),
    );
    expect(quarantined).toHaveLength(1);
    expect(FS.readFileSync(Path.join(directory, quarantined[0] as string), "utf8")).toBe(
      '{"version":1,"profiles":[{"id":"work-',
    );
    expect(new BrowserProfileStore({ storagePath }).list("thread-a")).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Work" })]),
    );
  });

  it("refuses to persist over a store whose bytes could not be read", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-browser-profiles-"));
    temporaryDirectories.push(directory);
    // A directory at the store path stands in for any non-ENOENT read failure
    // (EACCES, EIO): the previous contents are unknown, so writes must not run.
    const storagePath = Path.join(directory, "browser-profiles.json");
    FS.mkdirSync(storagePath);

    const store = new BrowserProfileStore({
      storagePath,
      createId: () => "cf6b7fbb-9d70-4b39-9a0e-8a2b1c4d5e6f",
    });
    expect(store.list("thread-a")).toHaveLength(2);
    expect(() => store.create("Work")).toThrow(/cannot be saved/);
    expect(() => store.bindThread("thread-a", PERSONAL_BROWSER_PROFILE_ID)).toThrow(
      /cannot be saved/,
    );
    expect(FS.statSync(storagePath).isDirectory()).toBe(true);
    expect(FS.readdirSync(directory)).toEqual(["browser-profiles.json"]);
  });

  it("returns affected threads to their temporary identity when deleting a profile", () => {
    const store = new BrowserProfileStore({
      createId: () => "7c0b0d17-99e0-4268-b652-6e1c7f57315a",
    });
    const profile = store.create("Shopping");
    store.bindThread("thread-a", profile.id);

    expect(store.delete(profile.id)).toEqual(["thread-a"]);
    expect(store.profileForThread("thread-a").id).toBe(TEMPORARY_BROWSER_PROFILE_ID);
  });
});
