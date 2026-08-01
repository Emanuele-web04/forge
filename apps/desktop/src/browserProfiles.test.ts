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
