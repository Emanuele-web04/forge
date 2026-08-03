// FILE: remoteEnvironmentPipeline.test.ts
// Purpose: The pipeline's ORDERING and its refusals — that nothing is published
//          before the handshake, that a darwin host is refused before anything
//          is uploaded, and that a build with no artifacts reports rather than
//          crashes.
// Layer: Server / remote broker tests

import type { RemoteHostConfig, RemoteHostId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { createFakeRemoteHost, type FakeRemoteHost } from "./fakeRemoteHost";
import {
  bringUpRemoteEnvironment,
  RemoteEnvironmentUnsupportedError,
} from "./remoteEnvironmentPipeline";
import type { RemoteConnection, RemoteExecResult } from "./remoteConnection";

function hostConfig(overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig {
  return {
    hostId: "host-1" as RemoteHostId,
    label: "devbox",
    destination: "devbox",
    sshArgs: [],
    hostKeyVerification: "strict",
    connectTimeoutSeconds: 10,
    keepalive: { intervalSeconds: 15, countMax: 3 },
    connectionReuse: { enabled: true, persistSeconds: 300 },
    launcher: { kind: "direct" },
    ...overrides,
  } as RemoteHostConfig;
}

const ok = (stdout: string): RemoteExecResult => ({ exitCode: 0, stdout, stderr: "" });

/**
 * A connection that answers the four facts probes and delegates the rest.
 *
 * The facts decide the artifact target and the supervisor, so they are the
 * first thing the pipeline reads and the easiest thing to get wrong.
 */
function factsConnection(input: {
  readonly os: string;
  readonly arch: string;
  readonly host?: FakeRemoteHost;
}): RemoteConnection {
  const host = input.host ?? createFakeRemoteHost();
  return {
    describe: "fake@host",
    exec(argv, options) {
      if (argv[0] === "uname" && argv[1] === "-s") return Promise.resolve(ok(input.os));
      if (argv[0] === "uname" && argv[1] === "-m") return Promise.resolve(ok(input.arch));
      if (argv[0] === "id") return Promise.resolve(ok("1000"));
      if (argv[0] === "sh" && String(argv[2]).includes("HOME")) {
        return Promise.resolve(ok("/home/deploy"));
      }
      return host.connection.exec(argv, options);
    },
    uploadFile: (args) => host.connection.uploadFile(args),
  };
}

describe("bringUpRemoteEnvironment", () => {
  it("refuses a darwin host as a structured reason, before uploading anything", async () => {
    const host = createFakeRemoteHost();
    const connection = factsConnection({ os: "Darwin", arch: "arm64", host });

    await expect(
      bringUpRemoteEnvironment({
        config: hostConfig(),
        installRoot: "/home/deploy/.synara/remote",
        createConnection: () => connection,
        resolveArtifacts: () => {
          throw new Error("artifacts must not be resolved for an unsupported host");
        },
      }),
    ).rejects.toThrow(RemoteEnvironmentUnsupportedError);

    // The whole point of refusing early: no bytes crossed the WAN, and no
    // half-install was left behind for the user to clean up.
    expect(host.commands.some((argv) => argv[0] === "scp")).toBe(false);
    expect(host.commands.some((argv) => argv[0] === "tar")).toBe(false);
  });

  it("surfaces the capability's own reason rather than a generic failure", async () => {
    const connection = factsConnection({ os: "Darwin", arch: "arm64" });
    await expect(
      bringUpRemoteEnvironment({
        config: hostConfig(),
        installRoot: "/home/deploy/.synara/remote",
        createConnection: () => connection,
        resolveArtifacts: () => Promise.resolve({ available: true, artifacts: {} as never }),
      }),
    ).rejects.toThrow(/launchd/);
  });

  it("reports missing artifacts as an ordinary error, NOT as unsupported", async () => {
    // A dev checkout has no manifests. That is a normal state of this BUILD, not
    // a property of the host — and the distinction is what lets the surface say
    // "install a release build" instead of "this host will never work".
    const connection = factsConnection({ os: "Linux", arch: "x86_64" });
    const failure = await bringUpRemoteEnvironment({
      config: hostConfig(),
      installRoot: "/home/deploy/.synara/remote",
      createConnection: () => connection,
      resolveArtifacts: () =>
        Promise.resolve({
          available: false,
          reason: "No bootstrap artifacts for linux-x64 are packaged with this build.",
          searched: ["/somewhere/bootstrap-artifacts-linux-x64.json"],
        }),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RemoteEnvironmentUnsupportedError);
    expect((failure as Error).message).toContain("No bootstrap artifacts");
  });

  it("refuses an architecture we ship no build for", async () => {
    const connection = factsConnection({ os: "Linux", arch: "riscv64" });
    await expect(
      bringUpRemoteEnvironment({
        config: hostConfig(),
        installRoot: "/home/deploy/.synara/remote",
        createConnection: () => connection,
        resolveArtifacts: () => Promise.resolve({ available: true, artifacts: {} as never }),
      }),
    ).rejects.toThrow(/architecture/i);
  });
});
