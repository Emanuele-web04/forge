import { describe, expect, it } from "vitest";
import { createAvatarStorage } from "./avatarStorage";
import type { AvatarStorageConfig } from "./config";

const config: AvatarStorageConfig = {
  endpoint: "https://storage.example.com",
  region: "auto",
  bucket: "avatars",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  publicBaseUrl: "https://avatars.example.com",
};

/** A fetch that never answers — it only rejects when its signal aborts. */
const stalledFetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(init.signal!.reason as Error);
    });
  })) as typeof fetch;

describe("createAvatarStorage timeouts", () => {
  it("rejects a stalled PUT with a timeout error instead of hanging", async () => {
    const storage = createAvatarStorage(config, stalledFetch, 20);
    await expect(
      storage.put("avatars/u/abc.png", new Uint8Array([1]), "image/png"),
    ).rejects.toThrow(/avatar storage PUT avatars\/u\/abc\.png timed out after 20ms/);
  });

  it("rejects a stalled DELETE with a timeout error instead of hanging", async () => {
    const storage = createAvatarStorage(config, stalledFetch, 20);
    await expect(storage.delete("avatars/u/abc.png")).rejects.toThrow(
      /avatar storage DELETE avatars\/u\/abc\.png timed out after 20ms/,
    );
  });
});
