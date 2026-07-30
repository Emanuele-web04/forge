// FILE: bootstrapArtifacts.ts
// Purpose: Describe the bytes we upload to a remote host and verify them on
//          both sides. The supply chain is the LOCAL artifact: nothing is ever
//          fetched from the internet by the remote host, so an air-gapped or
//          egress-filtered box bootstraps identically to a connected one.
// Layer: Server / remote broker
// Exports: BootstrapArtifact, BootstrapArtifactSet, hashLocalFile,
//          describeArtifact, verifyLocalArtifact, parseRemoteDigest,
//          assertDigestMatch, ChecksumMismatchError

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/** Lowercase hex SHA-256, the only digest form this module accepts. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface BootstrapArtifact {
  /** What this file is, for errors and progress. */
  readonly kind: "server-tarball" | "node-runtime";
  /** Absolute path on the LOCAL machine. */
  readonly localPath: string;
  /** File name to write under the remote staging directory. */
  readonly remoteFileName: string;
  /** Expected lowercase-hex SHA-256 of the file's bytes. */
  readonly sha256: string;
  /** Expected size in bytes; a cheap first-line mismatch signal. */
  readonly sizeBytes: number;
  /** POSIX mode for the uploaded file (the Node runtime needs 0o700). */
  readonly mode: number;
}

export interface BootstrapArtifactSet {
  readonly releaseId: string;
  /** Semantic version the remote server will report; used for skew checks. */
  readonly serverVersion: string;
  readonly serverTarball: BootstrapArtifact;
  readonly nodeRuntime: BootstrapArtifact;
}

export class ChecksumMismatchError extends Error {
  readonly artifactKind: BootstrapArtifact["kind"];
  readonly expected: string;
  readonly actual: string;

  constructor(input: {
    readonly artifactKind: BootstrapArtifact["kind"];
    readonly where: "local" | "remote";
    readonly expected: string;
    readonly actual: string;
  }) {
    super(
      `Checksum mismatch for ${input.artifactKind} on the ${input.where} side: expected ${input.expected}, got ${input.actual}`,
    );
    this.name = "ChecksumMismatchError";
    this.artifactKind = input.artifactKind;
    this.expected = input.expected;
    this.actual = input.actual;
  }
}

export function describeArtifact(artifact: BootstrapArtifact): string {
  return `${artifact.kind} (${artifact.remoteFileName})`;
}

export async function hashLocalFile(localPath: string): Promise<{
  readonly sha256: string;
  readonly sizeBytes: number;
}> {
  const hash = createHash("sha256");
  const stream = createReadStream(localPath);
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    sizeBytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

/**
 * Verify the local artifact before a single byte crosses the wire.
 *
 * This is not redundant with the remote check: it catches a corrupted or
 * swapped local cache early, and it means a remote mismatch unambiguously
 * indicates transfer damage rather than a bad source file.
 */
export async function verifyLocalArtifact(artifact: BootstrapArtifact): Promise<void> {
  if (!SHA256_HEX_PATTERN.test(artifact.sha256)) {
    throw new Error(
      `Artifact ${describeArtifact(artifact)} has a malformed expected SHA-256 digest`,
    );
  }
  const stats = await stat(artifact.localPath);
  if (!stats.isFile()) {
    throw new Error(`Artifact ${describeArtifact(artifact)} is not a regular file`);
  }
  const actual = await hashLocalFile(artifact.localPath);
  if (actual.sizeBytes !== artifact.sizeBytes) {
    throw new ChecksumMismatchError({
      artifactKind: artifact.kind,
      where: "local",
      expected: `${artifact.sizeBytes} bytes`,
      actual: `${actual.sizeBytes} bytes`,
    });
  }
  assertDigestMatch({ artifact, where: "local", actual: actual.sha256 });
}

/**
 * Parse the digest out of `sha256sum <file>` / `shasum -a 256 <file>` output.
 *
 * Returns null rather than guessing when the output is unrecognisable, so an
 * unexpected shell banner or a noisy rc file can never be read as a match.
 */
export function parseRemoteDigest(output: string): string | null {
  for (const line of output.split("\n")) {
    const digest = /^([0-9a-fA-F]{64})[ \t]+[ *]?\S/.exec(line.trim())?.[1];
    if (digest !== undefined) {
      return digest.toLowerCase();
    }
  }
  return null;
}

export function assertDigestMatch(input: {
  readonly artifact: BootstrapArtifact;
  readonly where: "local" | "remote";
  readonly actual: string | null;
}): void {
  const actual = input.actual?.toLowerCase() ?? null;
  if (actual === null) {
    throw new ChecksumMismatchError({
      artifactKind: input.artifact.kind,
      where: input.where,
      expected: input.artifact.sha256,
      actual: "<no digest in output>",
    });
  }
  if (actual !== input.artifact.sha256.toLowerCase()) {
    throw new ChecksumMismatchError({
      artifactKind: input.artifact.kind,
      where: input.where,
      expected: input.artifact.sha256,
      actual,
    });
  }
}
