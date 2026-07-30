import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertDigestMatch,
  type BootstrapArtifact,
  ChecksumMismatchError,
  hashLocalFile,
  parseRemoteDigest,
  verifyLocalArtifact,
} from "./bootstrapArtifacts";

const CONTENTS = "synara server tarball bytes";
const DIGEST = createHash("sha256").update(CONTENTS).digest("hex");

let directory: string;
let tarballPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "synara-artifacts-"));
  tarballPath = join(directory, "synara-server-0.6.3.tar.gz");
  await writeFile(tarballPath, CONTENTS);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function artifact(overrides: Partial<BootstrapArtifact> = {}): BootstrapArtifact {
  return {
    kind: "server-tarball",
    localPath: tarballPath,
    remoteFileName: "synara-server-0.6.3.tar.gz",
    sha256: DIGEST,
    sizeBytes: Buffer.byteLength(CONTENTS),
    mode: 0o600,
    ...overrides,
  };
}

describe("hashLocalFile", () => {
  it("reports the sha256 and byte length of the file", async () => {
    await expect(hashLocalFile(tarballPath)).resolves.toEqual({
      sha256: DIGEST,
      sizeBytes: Buffer.byteLength(CONTENTS),
    });
  });
});

describe("verifyLocalArtifact", () => {
  it("accepts a matching artifact", async () => {
    await expect(verifyLocalArtifact(artifact())).resolves.toBeUndefined();
  });

  // Mutation guard: without the digest comparison a swapped local cache would
  // be shipped to every host as if it were the pinned release.
  it("rejects a digest mismatch", async () => {
    await expect(verifyLocalArtifact(artifact({ sha256: "0".repeat(64) }))).rejects.toThrow(
      ChecksumMismatchError,
    );
  });

  // Mutation guard: the size check is the cheap truncation signal; removing it
  // must fail a test, not silently defer to the hash.
  it("rejects a size mismatch before hashing succeeds", async () => {
    await expect(verifyLocalArtifact(artifact({ sizeBytes: 1 }))).rejects.toThrow(
      /expected 1 bytes, got/,
    );
  });

  it("rejects a malformed expected digest rather than treating it as a wildcard", async () => {
    await expect(verifyLocalArtifact(artifact({ sha256: "not-a-digest" }))).rejects.toThrow(
      /malformed expected SHA-256/,
    );
    await expect(verifyLocalArtifact(artifact({ sha256: "" }))).rejects.toThrow(
      /malformed expected SHA-256/,
    );
  });

  it("rejects a directory posing as an artifact", async () => {
    await expect(verifyLocalArtifact(artifact({ localPath: directory }))).rejects.toThrow(
      /not a regular file/,
    );
  });
});

describe("parseRemoteDigest", () => {
  it("reads GNU sha256sum output", () => {
    expect(parseRemoteDigest(`${DIGEST}  /tmp/file.tar.gz\n`)).toBe(DIGEST);
  });

  it("reads BSD shasum binary-mode output", () => {
    expect(parseRemoteDigest(`${DIGEST} */tmp/file.tar.gz\n`)).toBe(DIGEST);
  });

  it("lowercases an uppercase digest", () => {
    expect(parseRemoteDigest(`${DIGEST.toUpperCase()}  file\n`)).toBe(DIGEST);
  });

  // Mutation guard: a noisy remote login shell prints banners before the real
  // output. Skipping non-matching lines must not turn into "take line 0".
  it("skips a noisy shell banner and finds the digest line", () => {
    expect(parseRemoteDigest(`Welcome to Ubuntu\nMOTD: be careful\n${DIGEST}  file\n`)).toBe(
      DIGEST,
    );
  });

  // Mutation guard: relaxing the pattern to accept a bare hex token would let
  // arbitrary shell chatter be read as a checksum.
  it.each([
    ["empty output", ""],
    ["a banner only", "Welcome to Ubuntu\n"],
    ["a short digest", `${"a".repeat(63)}  file\n`],
    ["a digest with no file name", `${DIGEST}\n`],
    ["a non-hex token", `${"z".repeat(64)}  file\n`],
  ])("returns null for %s", (_label, output) => {
    expect(parseRemoteDigest(output)).toBeNull();
  });
});

describe("assertDigestMatch", () => {
  it("accepts an exact match on either side", () => {
    expect(() =>
      assertDigestMatch({ artifact: artifact(), where: "remote", actual: DIGEST }),
    ).not.toThrow();
  });

  it("accepts a case-different match", () => {
    expect(() =>
      assertDigestMatch({ artifact: artifact(), where: "remote", actual: DIGEST.toUpperCase() }),
    ).not.toThrow();
  });

  // Mutation guard: a null digest means the remote produced no usable answer.
  // Treating that as a pass is the single worst failure this module can have.
  it("treats an absent remote digest as a mismatch, never a pass", () => {
    expect(() =>
      assertDigestMatch({ artifact: artifact(), where: "remote", actual: null }),
    ).toThrow(ChecksumMismatchError);
  });

  it("rejects a different digest", () => {
    expect(() =>
      assertDigestMatch({ artifact: artifact(), where: "remote", actual: "b".repeat(64) }),
    ).toThrow(ChecksumMismatchError);
  });
});
