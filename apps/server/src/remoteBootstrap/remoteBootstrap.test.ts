import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BootstrapArtifactSet } from "./bootstrapArtifacts";
import { ChecksumMismatchError } from "./bootstrapArtifacts";
import { createFakeRemoteHost, type FakeRemoteHost, InterruptionError } from "./fakeRemoteHost";
import type { ProvisioningClaim } from "./provisioningHandshake";
import {
  bootstrapRemoteServer,
  type BootstrapInput,
  readRemoteReleaseId,
  uninstallRemoteServer,
  UpgradeRefusedError,
} from "./remoteBootstrap";
import {
  isPathInsideInstallRoot,
  remoteCurrentNodePath,
  type RemoteInstallLayout,
  remoteInstallLayout,
} from "./remoteInstallLayout";
import { remoteSupervisorPlan } from "./remoteSupervisor";
import type { RequestedUpgrade } from "./remoteUpgradePolicy";

const ENVIRONMENT_ID = "6f9d0c6e-7a1f-4d2b-9a3c-0e5d1b2c3d4e";
const layout = remoteInstallLayout("/home/deploy/.synara/remote");

/** The fake tar payload is a JSON manifest the fake host expands. */
const TARBALL_MANIFEST = JSON.stringify({
  "dist/index.mjs": "// synara server\n",
  "package.json": '{"version":"0.6.3"}',
});
const NODE_RUNTIME_BYTES = "#!/fake/node binary bytes";

function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

let workspace: string;
let tarballPath: string;
let nodePath: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "synara-bootstrap-"));
  tarballPath = join(workspace, "synara-server-0.6.3.tar.gz");
  nodePath = join(workspace, "node-v22-linux-x64");
  await writeFile(tarballPath, TARBALL_MANIFEST);
  await writeFile(nodePath, NODE_RUNTIME_BYTES);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function artifacts(overrides: Partial<BootstrapArtifactSet> = {}): BootstrapArtifactSet {
  return {
    releaseId: "0.6.3",
    serverVersion: "0.6.3",
    serverTarball: {
      kind: "server-tarball",
      localPath: tarballPath,
      remoteFileName: "synara-server-0.6.3.tar.gz",
      sha256: digestOf(TARBALL_MANIFEST),
      sizeBytes: Buffer.byteLength(TARBALL_MANIFEST),
      mode: 0o600,
    },
    nodeRuntime: {
      kind: "node-runtime",
      localPath: nodePath,
      remoteFileName: "node",
      sha256: digestOf(NODE_RUNTIME_BYTES),
      sizeBytes: Buffer.byteLength(NODE_RUNTIME_BYTES),
      mode: 0o700,
    },
    ...overrides,
  };
}

const supervisor = remoteSupervisorPlan({
  os: "linux",
  layout,
  releaseId: "0.6.3",
  nodePath: remoteCurrentNodePath(layout),
  entrypointPath: `${layout.root}/current/dist/index.mjs`,
  port: 45123,
  instanceId: "env-abc123",
  homeDirectory: "/home/deploy",
  userId: 1000,
});

function bootstrapInput(
  host: FakeRemoteHost,
  overrides: Partial<BootstrapInput> = {},
): BootstrapInput {
  return {
    connection: host.connection,
    layout,
    artifacts: artifacts(),
    supervisor,
    environmentId: ENVIRONMENT_ID,
    probeHandshake: (credential): Promise<ProvisioningClaim> =>
      Promise.resolve({
        environmentId: ENVIRONMENT_ID,
        serverVersion: "0.6.3",
        acceptedToken: credential.token,
        authenticated: true,
      }),
    ...overrides,
  };
}

describe("clean-host bootstrap", () => {
  it("brings a clean host to a supervised, verified server", async () => {
    const host = createFakeRemoteHost();
    const outcome = await bootstrapRemoteServer(bootstrapInput(host));

    expect(outcome.releaseId).toBe("0.6.3");
    expect(outcome.previousReleaseId).toBeNull();
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
    expect(host.readFile(`${layout.currentLink}/dist/index.mjs`)).toBe("// synara server\n");
    expect(host.readFile(layout.environmentIdFile)?.trim()).toBe(ENVIRONMENT_ID);
    expect(await readRemoteReleaseId(host.connection, layout)).toBe("0.6.3");
  });

  // The bug this locks down (F1): staging the runtime without ever moving it
  // into the release tree left ExecStart naming a binary that did not exist, so
  // a "successful" bootstrap produced a unit systemd could not launch at all.
  // Asserting on the unit's own ExecStart — rather than a hardcoded path — is
  // what makes this catch any future drift between the two.
  it("places every binary the unit's ExecStart names inside the activated release", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));

    const execStart = /^ExecStart=(.*)$/m.exec(supervisor.unitContents)?.[1];
    expect(execStart).toBeDefined();
    const absolutePaths = execStart
      ?.split(" ")
      .filter((token) => token.startsWith("/"))
      .map((token) => token.replaceAll("'", ""));
    // The node binary and the entrypoint: if this ever drops to one, the loop
    // below stops proving anything.
    expect(absolutePaths).toHaveLength(2);
    for (const path of absolutePaths ?? []) {
      expect(path.startsWith(`${layout.currentLink}/`)).toBe(true);
      expect(host.readFile(path), `${path} must exist under current`).not.toBeNull();
    }
  });

  it("keeps the pinned runtime with the release, so a rollback restores its own node", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    expect(host.readFile(`${layout.releasesDirectory}/0.6.3/node`)).toBe(NODE_RUNTIME_BYTES);
    expect(host.readFile(`${layout.currentLink}/node`)).toBe(NODE_RUNTIME_BYTES);
  });

  it("makes the installed runtime executable", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    expect(host.commands).toContainEqual([
      "chmod",
      "700",
      "--",
      `${layout.releasesDirectory}/0.6.3/node`,
    ]);
  });

  // The whole point of upload-first: an air-gapped host must never be asked to
  // reach the internet. Mutation guard against a "just curl it" regression.
  //
  // Scans the whole command line, not just argv[0]: this module legitimately
  // runs `sh -c` to write the credential, and that is exactly the shape a
  // future `sh -c "curl ... | sh"` regression would hide behind.
  it.each(["curl", "wget", "npm", "npx", "pip", "apt-get", "yum", "brew", "git"])(
    "never invokes %s on the remote host",
    async (command) => {
      const host = createFakeRemoteHost();
      await bootstrapRemoteServer(bootstrapInput(host));
      for (const argv of host.commands) {
        expect(argv.join(" ")).not.toMatch(new RegExp(`\\b${command}\\b`));
      }
    },
  );

  it("provisions a credential rather than expecting an open socket", async () => {
    const host = createFakeRemoteHost();
    const outcome = await bootstrapRemoteServer(bootstrapInput(host));
    expect(host.readFile(layout.credentialFile)?.trim()).toBe(outcome.credential.token);
  });

  // Mutation guard: passing the secret as an argument puts it in the remote
  // process table, readable by every other user on the host.
  it("never passes the credential as a command argument", async () => {
    const host = createFakeRemoteHost();
    const outcome = await bootstrapRemoteServer(bootstrapInput(host));
    for (const argv of host.commands) {
      for (const token of argv) {
        expect(token).not.toContain(outcome.credential.token);
      }
    }
  });

  it("writes the credential with owner-only permissions", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    const chmods = host.commands.filter((argv) => argv[0] === "chmod");
    // 0600 is set on the temp file BEFORE it is renamed into place, so the
    // credential is never briefly world-readable at its real path.
    expect(chmods).toContainEqual(["chmod", "600", "--", `${layout.credentialFile}.new`]);
    expect(chmods).toContainEqual(["chmod", "700", "--", layout.root, layout.stateDirectory]);
    expect(host.readFile(layout.credentialFile)).not.toBeNull();
  });

  it("starts the supervisor and enables linger", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    expect(host.commands).toContainEqual(["loginctl", "enable-linger"]);
    expect(host.commands).toContainEqual(["systemctl", "--user", "restart", supervisor.unitName]);
  });

  it("clears the staging directory only after the handshake succeeds", async () => {
    const host = createFakeRemoteHost();
    const order: string[] = [];
    await bootstrapRemoteServer(
      bootstrapInput(host, {
        onProgress: (progress) => order.push(progress.step),
        probeHandshake: (credential) => {
          expect(host.exists(`${layout.stagingDirectory}/node`)).toBe(true);
          return Promise.resolve({
            environmentId: ENVIRONMENT_ID,
            serverVersion: "0.6.3",
            acceptedToken: credential.token,
            authenticated: true,
          });
        },
      }),
    );
    expect(order.at(-1)).toBe("handshake");
    expect(host.exists(`${layout.stagingDirectory}/node`)).toBe(false);
  });
});

describe("checksum enforcement", () => {
  it("refuses when the local artifact does not match its pinned digest", async () => {
    const host = createFakeRemoteHost();
    const bad = artifacts();
    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: { ...bad, serverTarball: { ...bad.serverTarball, sha256: "0".repeat(64) } },
        }),
      ),
    ).rejects.toThrow(ChecksumMismatchError);
    expect(host.exists(layout.currentLink)).toBe(false);
  });

  // Mutation guard: without the post-upload remote verification, transfer
  // corruption is activated and supervised.
  it("refuses when the uploaded bytes are corrupted in transit", async () => {
    const host = createFakeRemoteHost();
    // A lossy link, not a dropped one: scp reports success but the bytes on the
    // far side differ. Only the post-upload remote digest can catch this.
    host.corruptNextUpload(
      `${layout.stagingDirectory}/synara-server-0.6.3.tar.gz`,
      `${TARBALL_MANIFEST} `,
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(
      ChecksumMismatchError,
    );
    expect(host.exists(layout.currentLink)).toBe(false);
    expect(host.exists(`${layout.releasesDirectory}/0.6.3`)).toBe(false);
  });

  it("refuses corruption of the node runtime too, not just the tarball", async () => {
    const host = createFakeRemoteHost();
    host.corruptNextUpload(`${layout.stagingDirectory}/node`, "#!/evil");
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(
      ChecksumMismatchError,
    );
    expect(host.exists(layout.currentLink)).toBe(false);
  });

  // Mutation guard (M2/M5): a non-zero exit means "no digest", never "matches".
  // The second case is the dangerous one — a host that prints a plausible
  // digest line while failing must not have that output parsed as a match.
  it.each([
    ["silently", ""],
    ["while printing a valid-looking digest", `${"a".repeat(64)}  node\n`],
    ["while printing the expected digest", null],
  ])("refuses to activate when sha256sum exits non-zero %s", async (_label, stdout) => {
    const host = createFakeRemoteHost();
    const expectedDigest = digestOf(NODE_RUNTIME_BYTES);
    host.stubExit(
      (argv) => argv[0] === "sha256sum" && argv.includes(`${layout.stagingDirectory}/node`),
      { exitCode: 1, stdout: stdout ?? `${expectedDigest}  node\n`, stderr: "sha256sum: failed" },
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(
      ChecksumMismatchError,
    );
    expect(host.exists(layout.currentLink)).toBe(false);
  });

  it("refuses when the remote cannot produce a digest at all", async () => {
    const host = createFakeRemoteHost();
    // Both digest tools missing: a host that answers nothing must not pass.
    host.failOn(
      (argv) => argv[0] === "sha256sum" && argv.includes(`${layout.stagingDirectory}/node`),
      () => {
        throw new InterruptionError("sha256sum unavailable");
      },
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow();
    expect(host.exists(layout.currentLink)).toBe(false);
  });
});

describe("hostile artifact file names", () => {
  // remoteFileName is caller-influenced and lands in two dangerous positions:
  // joined onto a path, and passed to tar as an operand. Both are covered here.
  const hostileNames = [
    "../../../../tmp/pwned.tar.gz",
    "../escape",
    "..",
    "./x",
    "a/b",
    "/absolute",
    "--checkpoint-action=exec=sh",
    "--to-command=sh",
    "-rf",
    "with space.tar.gz",
    "quote'.tar.gz",
    'double".tar.gz',
    "new\nline",
    "semi;colon",
    "$(id)",
    "`id`",
    "$HOME",
    "pipe|cat",
    "null\0byte",
    "unicodé.tar.gz",
    "‮gnp.exe",
    "",
  ];

  it.each(hostileNames)("refuses to stage an artifact named %j", async (remoteFileName) => {
    const host = createFakeRemoteHost();
    const base = artifacts();
    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: { ...base, serverTarball: { ...base.serverTarball, remoteFileName } },
        }),
      ),
    ).rejects.toThrow(/Invalid remote artifact file name/);

    // Nothing was uploaded, and in particular nothing outside the install root.
    for (const argv of host.commands) {
      if (argv[0] === "scp") {
        expect(isPathInsideInstallRoot(layout, argv[2] ?? "")).toBe(true);
      }
    }
    expect(host.exists(layout.currentLink)).toBe(false);
  });

  // The property the individual cases above are instances of: whatever a name
  // is, every path we ever upload to stays inside the tree uninstall can clean.
  it("never uploads outside the install root, whatever the name", async () => {
    for (const remoteFileName of [...hostileNames, "node", "synara-server-0.6.3.tar.gz"]) {
      const host = createFakeRemoteHost();
      const base = artifacts();
      await bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: { ...base, nodeRuntime: { ...base.nodeRuntime, remoteFileName } },
        }),
      ).catch(() => undefined);
      for (const argv of host.commands) {
        if (argv[0] === "scp") {
          expect(isPathInsideInstallRoot(layout, argv[2] ?? "")).toBe(true);
        }
      }
    }
  });

  // Mutation guard: tar treats a leading-dash operand as a flag, and
  // --checkpoint-action=exec= is a documented arbitrary-execution vector. The
  // name validator is the first defence; this `--` is the second.
  it("passes -- to tar so a staged file can never be read as a flag", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    const tarCommands = host.commands.filter((argv) => argv[0] === "tar");
    expect(tarCommands).not.toHaveLength(0);
    for (const argv of tarCommands) {
      expect(argv).toContain("--");
    }
  });
});

describe("resume after an interrupted upload", () => {
  it("re-uploads a truncated staged artifact instead of trusting it", async () => {
    const host = createFakeRemoteHost();
    host.failOn(
      (argv) => argv[0] === "systemctl" && argv[2] === "enable",
      () => {
        throw new InterruptionError("connection dropped mid-bootstrap");
      },
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(InterruptionError);

    // A killed upload leaves a short file behind.
    host.truncate(`${layout.stagingDirectory}/synara-server-0.6.3.tar.gz`, 5);
    const uploadsBefore = host.commands.filter((argv) => argv[0] === "scp").length;

    await bootstrapRemoteServer(bootstrapInput(host));

    const uploadsAfter = host.commands.filter((argv) => argv[0] === "scp").length;
    expect(uploadsAfter).toBeGreaterThan(uploadsBefore);
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
  });

  // Mutation guard: dropping the reuse check makes resume pay for a full
  // re-upload every time, which on a WAN link is the difference between a
  // resumable bootstrap and an unusable one.
  it("skips re-uploading an artifact that is already staged intact", async () => {
    const host = createFakeRemoteHost();
    host.failOn(
      (argv) => argv[0] === "systemctl" && argv[2] === "enable",
      () => {
        throw new InterruptionError("connection dropped mid-bootstrap");
      },
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(InterruptionError);

    const steps: string[] = [];
    await bootstrapRemoteServer(bootstrapInput(host, { onProgress: (p) => steps.push(p.step) }));
    expect(steps.filter((step) => step === "reusing-staged")).toHaveLength(2);
    expect(steps).not.toContain("uploading");
  });

  it("never leaves a partially extracted tree at the release path", async () => {
    const host = createFakeRemoteHost();
    host.failOn(
      (argv) => argv[0] === "tar",
      () => {
        throw new InterruptionError("connection dropped during extraction");
      },
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(InterruptionError);
    // The scratch directory may exist; the release path must not.
    expect(host.exists(`${layout.releasesDirectory}/0.6.3`)).toBe(false);
    expect(host.exists(layout.currentLink)).toBe(false);
  });
});

describe("handshake failure rolls back", () => {
  async function bootstrapOnce(host: FakeRemoteHost): Promise<void> {
    await bootstrapRemoteServer(bootstrapInput(host));
  }

  it("restores the previous release when the new one fails verification", async () => {
    const host = createFakeRemoteHost();
    await bootstrapOnce(host);

    const upgraded = artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" });
    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: upgraded,
          // The activated release reports the wrong version: something else is
          // serving on that port. Every other field is correct, so the version
          // is the only thing that can reject it.
          probeHandshake: (credential) =>
            Promise.resolve({
              environmentId: ENVIRONMENT_ID,
              serverVersion: "0.6.3",
              acceptedToken: credential.token,
              authenticated: true,
            }),
        }),
      ),
    ).rejects.toThrow(/not the one running/);

    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
  });

  // Mutation guard: the strongest security predicate in the flow. Without the
  // environmentId check the broker would attach to a foreign server listening
  // on the forwarded port.
  it("rolls back rather than exposing a server with a foreign environmentId", async () => {
    const host = createFakeRemoteHost();
    await bootstrapOnce(host);

    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
          probeHandshake: (credential) =>
            Promise.resolve({
              environmentId: "00000000-0000-4000-8000-000000000000",
              serverVersion: "0.7.0",
              acceptedToken: credential.token,
              authenticated: true,
            }),
        }),
      ),
    ).rejects.toThrow(/did not provision/);
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
  });

  it("rolls back when the remote refuses the provisioned credential", async () => {
    const host = createFakeRemoteHost();
    await bootstrapOnce(host);
    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
          probeHandshake: (credential) =>
            Promise.resolve({
              environmentId: ENVIRONMENT_ID,
              serverVersion: "0.7.0",
              acceptedToken: credential.token,
              authenticated: false,
            }),
        }),
      ),
    ).rejects.toThrow(/did not accept the provisioned credential/);
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
  });

  it("leaves no dangling current link on a first-install handshake failure", async () => {
    const host = createFakeRemoteHost();
    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          probeHandshake: () =>
            Promise.resolve({
              environmentId: undefined,
              serverVersion: undefined,
              acceptedToken: undefined,
              authenticated: false,
            }),
        }),
      ),
    ).rejects.toThrow();
    expect(host.exists(layout.currentLink)).toBe(false);
    expect(host.commands).toContainEqual(["systemctl", "--user", "stop", supervisor.unitName]);
  });
});

describe("environmentId validation", () => {
  // The handshake proves identity by comparing the reported environmentId to
  // this one. An empty string compares equal to an empty string, which would
  // turn the strongest check in the bootstrap into a tautology.
  it.each(["", "   ", "not-a-uuid", "6f9d0c6e7a1f4d2b9a3c0e5d1b2c3d4e", "../../etc", "0"])(
    "refuses to bootstrap with environmentId %j",
    async (environmentId) => {
      const host = createFakeRemoteHost();
      await expect(bootstrapRemoteServer(bootstrapInput(host, { environmentId }))).rejects.toThrow(
        /Invalid remote environment id/,
      );
      // Rejected at the entry point: nothing was touched on the remote host.
      expect(host.commands).toEqual([]);
    },
  );

  it("accepts a UUID and normalizes its case", async () => {
    const host = createFakeRemoteHost();
    const outcome = await bootstrapRemoteServer(
      bootstrapInput(host, {
        environmentId: ENVIRONMENT_ID.toUpperCase(),
        probeHandshake: (credential) =>
          Promise.resolve({
            environmentId: ENVIRONMENT_ID,
            serverVersion: "0.6.3",
            acceptedToken: credential.token,
            authenticated: true,
          }),
      }),
    );
    expect(outcome.environmentId).toBe(ENVIRONMENT_ID);
  });
});

describe("interrupted activation does not leave current lying", () => {
  // The bug this locks down (F7): the try/catch used to start after the
  // supervisor was installed and started, so a connection dropped at
  // `systemctl restart` left `current` pointing at the new release while the
  // old one was still running. readRemoteReleaseId then reports the new id and
  // the version-skew policy believes it.
  it.each([
    ["the supervisor install", (argv: ReadonlyArray<string>) => argv[2] === "enable"],
    ["the supervisor restart", (argv: ReadonlyArray<string>) => argv[2] === "restart"],
  ])("rolls current back when the connection drops at %s", async (_label, match) => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));

    host.failOn(
      (argv) => argv[0] === "systemctl" && match(argv),
      () => {
        throw new InterruptionError("connection dropped mid-upgrade");
      },
    );

    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
        }),
      ),
    ).rejects.toThrow(InterruptionError);

    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
    expect(await readRemoteReleaseId(host.connection, layout)).toBe("0.6.3");
  });

  it("rolls current back when writing the unit file fails", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));

    host.failOn(
      (argv) => argv[0] === "sh" && argv.includes(`${supervisor.unitPath}.new`),
      () => {
        throw new InterruptionError("connection dropped writing the unit");
      },
    );

    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
        }),
      ),
    ).rejects.toThrow(InterruptionError);
    expect(await readRemoteReleaseId(host.connection, layout)).toBe("0.6.3");
  });
});

describe("activation is atomic", () => {
  // `ln -sfn` unlinks before it creates, so an interruption in that window
  // leaves `current` pointing at NOTHING and the supervisor with nothing to
  // launch. The fake models that window explicitly (failMidCommand) — modelling
  // ln as one map write is what hid this. `mv -T` is a single rename(2), so the
  // name never stops resolving.
  it("never leaves current dangling when interrupted mid-swap", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));

    // Any ln that targets `current` itself would be the non-atomic form.
    host.failMidCommand(
      (argv) => argv[0] === "ln" && argv.includes(layout.currentLink),
      () => {
        throw new InterruptionError("connection dropped mid-symlink-swap");
      },
    );

    await bootstrapRemoteServer(
      bootstrapInput(host, {
        artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
        probeHandshake: (credential) =>
          Promise.resolve({
            environmentId: ENVIRONMENT_ID,
            serverVersion: "0.7.0",
            acceptedToken: credential.token,
            authenticated: true,
          }),
      }),
    );

    // The mid-swap fault never fired, because no `ln` ever names `current`.
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.7.0`);
  });

  it("swaps current with an atomic rename rather than unlink-then-create", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));

    // Every ln writes a temp name; only mv -T ever names `current`.
    for (const argv of host.commands) {
      if (argv[0] === "ln") {
        expect(argv).not.toContain(layout.currentLink);
        expect(argv).not.toContain(layout.previousLink);
      }
    }
    const swaps = host.commands.filter(
      (argv) => argv[0] === "mv" && argv.includes(layout.currentLink),
    );
    expect(swaps).not.toHaveLength(0);
    for (const argv of swaps) {
      expect(argv.some((token) => token.startsWith("-") && token.includes("T"))).toBe(true);
    }
  });

  it("rolls back with the same atomic swap", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    const before = host.commands.length;

    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
          probeHandshake: (credential) =>
            Promise.resolve({
              environmentId: ENVIRONMENT_ID,
              serverVersion: "0.6.3",
              acceptedToken: credential.token,
              authenticated: true,
            }),
        }),
      ),
    ).rejects.toThrow(/not the one running/);

    for (const argv of host.commands.slice(before)) {
      if (argv[0] === "ln") expect(argv).not.toContain(layout.currentLink);
    }
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
  });
});

describe("a retry of the running version never deletes it", () => {
  // The bug: extractRelease removed releases/<id> before moving scratch into
  // place, so re-running the SAME version after a post-activation interruption
  // deleted the directory `current` resolves to — killing the running server.
  it("keeps the active release intact when the same version is bootstrapped again", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    expect(host.readFile(`${layout.currentLink}/dist/index.mjs`)).toBe("// synara server\n");

    // Same release id, same bytes: the resume case.
    await bootstrapRemoteServer(bootstrapInput(host));

    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
    expect(host.readFile(`${layout.currentLink}/dist/index.mjs`)).toBe("// synara server\n");
    expect(host.readFile(`${layout.currentLink}/node`)).toBe(NODE_RUNTIME_BYTES);
  });

  it("never issues an rm against the directory current resolves to", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    const activeDirectory = host.readLink(layout.currentLink);
    const before = host.commands.length;

    await bootstrapRemoteServer(bootstrapInput(host));

    for (const argv of host.commands.slice(before)) {
      if (argv[0] === "rm") {
        expect(argv).not.toContain(activeDirectory);
      }
    }
  });
});

describe("successful upgrade records a rollback target", () => {
  it("points previous at the release it replaced", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    const outcome = await bootstrapRemoteServer(
      bootstrapInput(host, {
        artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
        probeHandshake: (credential) =>
          Promise.resolve({
            environmentId: ENVIRONMENT_ID,
            serverVersion: "0.7.0",
            acceptedToken: credential.token,
            authenticated: true,
          }),
      }),
    );
    expect(outcome.previousReleaseId).toBe("0.6.3");
    expect(host.readLink(layout.previousLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.7.0`);
  });
});

describe("first-install rollback on a host without a supervisor", () => {
  // Observed live against a container with no systemd: the supervisor install
  // fails at `systemctl`, and the rollback's stop step then failed the SAME
  // way. With the stop running before the rm — or its failure propagating —
  // `current` was left pointing at a release that never passed its handshake,
  // and a later readRemoteReleaseId believes that link. The invariant is the
  // link, not the stop.
  it("removes current even when the supervisor's stop command also fails", async () => {
    const host = createFakeRemoteHost();
    // stubExit, not failOn: failOn is one-shot, and the point is that EVERY
    // systemctl fails — the install's and then the rollback's, exactly like a
    // host with no systemd at all. exit 127 is what a missing binary returns.
    host.stubExit((argv) => argv[0] === "systemctl", {
      exitCode: 127,
      stdout: "",
      stderr: "sh: systemctl: command not found",
    });
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(/systemctl/);
    expect(host.readLink(layout.currentLink)).toBeNull();
  });
});

describe("uninstall", () => {
  it("leaves no files, units, or processes behind", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    await uninstallRemoteServer({ connection: host.connection, layout, supervisor });

    expect(host.listUnder(layout.root)).toEqual([]);
    expect(host.commands).toContainEqual(["systemctl", "--user", "disable", supervisor.unitName]);
    expect(host.commands).toContainEqual([
      "rm",
      "-f",
      "--",
      `/home/deploy/.config/systemd/user/${supervisor.unitName}`,
    ]);
  });

  // Mutation guard: a `pkill -f synara` here would kill an unrelated Synara on
  // the same host. Every kill must name a pid read from OUR pidfile — AND that
  // pid must be proven to be our process before it is signalled.
  it("kills the pidfile's process when it is provably ours, and never by pattern", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    host.nodes.set(layout.pidFile, { kind: "file", contents: "4242\n", mode: 0o600 });
    host.registerProcess(4242, `${layout.releasesDirectory}/0.6.3/node`);

    const before = host.commands.length;
    await uninstallRemoteServer({ connection: host.connection, layout, supervisor });
    const during = host.commands.slice(before);

    expect(during.filter((argv) => argv[0] === "kill")).toEqual([["kill", "-TERM", "4242"]]);
    for (const argv of during) {
      expect(["pkill", "killall", "pgrep", "xargs"]).not.toContain(argv[0]);
    }
  });

  // The finding: pids are recycled, so a stale pidfile plus a reboot routinely
  // names a live process belonging to someone else. The number alone proves
  // nothing; the executable behind it is what establishes ownership.
  it.each([
    ["a system daemon", "/usr/sbin/sshd"],
    ["another user's node", "/usr/bin/node"],
    ["a different Synara install", "/home/other/.synara/remote/releases/0.6.3/node"],
    ["a sibling path sharing our prefix", "/home/deploy/.synara/remote-backup/node"],
  ])("refuses to signal a recycled pid running %s", async (_label, executablePath) => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    host.nodes.set(layout.pidFile, { kind: "file", contents: "4242\n", mode: 0o600 });
    host.registerProcess(4242, executablePath);

    const before = host.commands.length;
    await uninstallRemoteServer({ connection: host.connection, layout, supervisor });
    expect(host.commands.slice(before).filter((argv) => argv[0] === "kill")).toEqual([]);
  });

  it("does not signal a pid that no longer exists", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    host.nodes.set(layout.pidFile, { kind: "file", contents: "4242\n", mode: 0o600 });
    // No registerProcess: /proc/4242/exe does not resolve.
    const before = host.commands.length;
    await uninstallRemoteServer({ connection: host.connection, layout, supervisor });
    expect(host.commands.slice(before).filter((argv) => argv[0] === "kill")).toEqual([]);
  });

  // "4242garbage" must not parse as 4242 the way Number.parseInt does.
  it.each([null, "", "   ", "not-a-pid", "0", "1", "-5", "4242garbage", "42 42", "0x10", "1e3"])(
    "does not kill anything for pidfile contents %j",
    async (pidContents) => {
      const host = createFakeRemoteHost();
      await bootstrapRemoteServer(bootstrapInput(host));
      // Register a process at every pid these could be misread as, so a lax
      // parser would find a live, owned target and actually signal it.
      for (const pid of [0, 1, 5, 42, 1000, 4242]) {
        host.registerProcess(pid, `${layout.releasesDirectory}/0.6.3/node`);
      }
      if (pidContents === null) {
        host.nodes.delete(layout.pidFile);
      } else {
        host.nodes.set(layout.pidFile, { kind: "file", contents: pidContents, mode: 0o600 });
      }
      const before = host.commands.length;
      await uninstallRemoteServer({ connection: host.connection, layout, supervisor });
      expect(host.commands.slice(before).filter((argv) => argv[0] === "kill")).toEqual([]);
    },
  );

  // The bug this locks down (F3): the old guard was
  // isPathInsideInstallRoot(layout, layout.root) — structurally `x === x`, so it
  // could never fire. A hand-built layout with root "/" produced a literal
  // ["rm","-rf","--","/"]. The brand on RemoteInstallLayout makes this a compile
  // error too, hence the cast: the runtime assertion is the backstop for any
  // caller that reaches this through `any`, JS, or a structured-clone boundary.
  it.each(["/", "/home", "/usr", "/Users", "/home/alice", "relative/path"])(
    "refuses to uninstall a hand-built layout rooted at %j",
    async (root) => {
      const host = createFakeRemoteHost();
      const hostile = {
        ...layout,
        root,
        releasesDirectory: `${root}/releases`,
        stateDirectory: `${root}/state`,
        pidFile: `${root}/state/synara.pid`,
      } as unknown as RemoteInstallLayout;

      await expect(
        uninstallRemoteServer({ connection: host.connection, layout: hostile, supervisor }),
      ).rejects.toThrow(/Refusing to manage|absolute POSIX path|home directory root/);

      for (const argv of host.commands) {
        expect(argv[0]).not.toBe("rm");
      }
    },
  );

  it("still removes files when the unit was never installed", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    host.failOn(
      (argv) => argv[0] === "systemctl" && argv[2] === "stop",
      () => {
        throw new InterruptionError("unit not loaded");
      },
    );
    // The stop failure is thrown by the fake, so the caller sees it — but a
    // non-zero exit (the realistic case) must not stop the cleanup.
    await expect(
      uninstallRemoteServer({ connection: host.connection, layout, supervisor }),
    ).rejects.toThrow(InterruptionError);

    const host2 = createFakeRemoteHost();
    // Never bootstrapped: every supervisor command exits non-zero.
    await expect(
      uninstallRemoteServer({ connection: host2.connection, layout, supervisor }),
    ).resolves.toBeUndefined();
  });
});

describe("the drain policy actually gates the upgrade", () => {
  // Before this, evaluateUpgradeGate was referenced only by its own tests: the
  // policy passed while bootstrap ran `systemctl restart` unconditionally, so
  // an upgrade could still preempt a streaming turn.
  const requestedUpgrade: RequestedUpgrade = {
    userInvoked: true,
    drain: { activeTurnCount: 0 },
    elapsedDrainMs: 0,
    drainTimeoutMs: 120_000,
  };

  async function installBaseline(host: FakeRemoteHost): Promise<void> {
    await bootstrapRemoteServer(bootstrapInput(host));
  }

  function upgradeInput(host: FakeRemoteHost, upgrade: Partial<RequestedUpgrade>): BootstrapInput {
    return bootstrapInput(host, {
      artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
      upgrade: { ...requestedUpgrade, ...upgrade },
      probeHandshake: (credential) =>
        Promise.resolve({
          environmentId: ENVIRONMENT_ID,
          serverVersion: "0.7.0",
          acceptedToken: credential.token,
          authenticated: true,
        }),
    });
  }

  it("refuses an upgrade nobody asked for", async () => {
    const host = createFakeRemoteHost();
    await installBaseline(host);
    const before = host.commands.length;

    await expect(bootstrapRemoteServer(upgradeInput(host, { userInvoked: false }))).rejects.toThrow(
      UpgradeRefusedError,
    );

    // Nothing was restarted and current still points at the old release.
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
    expect(
      host.commands
        .slice(before)
        .filter((argv) => argv[0] === "systemctl" && argv[2] === "restart"),
    ).toEqual([]);
  });

  it("waits rather than preempting a streaming turn", async () => {
    const host = createFakeRemoteHost();
    await installBaseline(host);
    const before = host.commands.length;

    const error = await bootstrapRemoteServer(
      upgradeInput(host, { drain: { activeTurnCount: 2 } }),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(UpgradeRefusedError);
    expect((error as UpgradeRefusedError).gate).toEqual({ decision: "wait", activeTurnCount: 2 });
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
    expect(
      host.commands
        .slice(before)
        .filter((argv) => argv[0] === "systemctl" && argv[2] === "restart"),
    ).toEqual([]);
  });

  it("reports a drain timeout instead of silently forcing the swap", async () => {
    const host = createFakeRemoteHost();
    await installBaseline(host);

    const error = await bootstrapRemoteServer(
      upgradeInput(host, {
        drain: { activeTurnCount: 1 },
        elapsedDrainMs: 120_000,
        drainTimeoutMs: 120_000,
      }),
    ).catch((cause: unknown) => cause);

    expect((error as UpgradeRefusedError).gate).toEqual({
      decision: "drain-timeout",
      activeTurnCount: 1,
    });
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
  });

  it("does no work when the target release already runs", async () => {
    const host = createFakeRemoteHost();
    await installBaseline(host);
    const before = host.commands.length;

    const error = await bootstrapRemoteServer(
      bootstrapInput(host, { upgrade: requestedUpgrade }),
    ).catch((cause: unknown) => cause);

    expect((error as UpgradeRefusedError).gate).toEqual({ decision: "already-current" });
    expect(host.commands.slice(before).filter((argv) => argv[0] === "scp")).toEqual([]);
  });

  it("proceeds when the user asked and nothing is in flight", async () => {
    const host = createFakeRemoteHost();
    await installBaseline(host);
    const outcome = await bootstrapRemoteServer(upgradeInput(host, {}));
    expect(outcome.releaseId).toBe("0.7.0");
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.7.0`);
  });

  // A refused gate must not have touched the box at all — not even an upload.
  it("uploads nothing when the gate refuses", async () => {
    const host = createFakeRemoteHost();
    await installBaseline(host);
    const before = host.commands.length;
    await bootstrapRemoteServer(upgradeInput(host, { userInvoked: false })).catch(() => undefined);
    expect(host.commands.slice(before).filter((argv) => argv[0] === "scp")).toEqual([]);
    expect(host.exists(`${layout.releasesDirectory}/0.7.0`)).toBe(false);
  });
});

describe("concurrent bootstraps are serialized", () => {
  // Two runs share staging, .incoming, the credential file, the unit, and
  // current. Interleaved, the second overwrites the first's credential and the
  // first then rolls back a release the second just activated.
  it("refuses to start while another bootstrap holds the lock", async () => {
    const host = createFakeRemoteHost();
    host.nodes.set(layout.lockFile, { kind: "directory" });

    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(
      /Another bootstrap is already running/,
    );
    expect(host.exists(layout.currentLink)).toBe(false);
  });

  it("releases the lock after a successful run", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    expect(host.exists(layout.lockFile)).toBe(false);
    // Which means a subsequent run can take it.
    await expect(bootstrapRemoteServer(bootstrapInput(host))).resolves.toBeDefined();
  });

  it("releases the lock even when the bootstrap fails", async () => {
    const host = createFakeRemoteHost();
    host.failOn(
      (argv) => argv[0] === "tar",
      () => {
        throw new InterruptionError("connection dropped during extraction");
      },
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(InterruptionError);
    expect(host.exists(layout.lockFile)).toBe(false);
  });

  it("holds the lock for the whole run, not just the start", async () => {
    const host = createFakeRemoteHost();
    let heldDuringHandshake = false;
    await bootstrapRemoteServer(
      bootstrapInput(host, {
        probeHandshake: (credential) => {
          heldDuringHandshake = host.exists(layout.lockFile);
          return Promise.resolve({
            environmentId: ENVIRONMENT_ID,
            serverVersion: "0.6.3",
            acceptedToken: credential.token,
            authenticated: true,
          });
        },
      }),
    );
    expect(heldDuringHandshake).toBe(true);
  });
});

describe("credential rotation is crash-safe", () => {
  it("writes the credential through a temp file and renames it into place", async () => {
    const host = createFakeRemoteHost();
    const outcome = await bootstrapRemoteServer(bootstrapInput(host));

    // The live path is only ever produced by a rename, never written directly.
    for (const argv of host.commands) {
      if (argv[0] === "sh") {
        expect(argv).not.toContain(layout.credentialFile);
      }
    }
    expect(host.commands).toContainEqual([
      "mv",
      "-fT",
      "--",
      `${layout.credentialFile}.new`,
      layout.credentialFile,
    ]);
    expect(host.readFile(layout.credentialFile)?.trim()).toBe(outcome.credential.token);
  });

  it("keeps the outgoing credential recoverable across an upgrade", async () => {
    const host = createFakeRemoteHost();
    const first = await bootstrapRemoteServer(bootstrapInput(host));

    const second = await bootstrapRemoteServer(
      bootstrapInput(host, {
        artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
        probeHandshake: (credential) =>
          Promise.resolve({
            environmentId: ENVIRONMENT_ID,
            serverVersion: "0.7.0",
            acceptedToken: credential.token,
            authenticated: true,
          }),
      }),
    );

    expect(host.readFile(layout.credentialFile)?.trim()).toBe(second.credential.token);
    expect(host.readFile(layout.previousCredentialFile)?.trim()).toBe(first.credential.token);
  });

  // Rolling the release back but leaving the NEW credential in place would
  // restart the old server under a token the broker never gave it.
  it("restores the previous credential when a failed upgrade rolls back", async () => {
    const host = createFakeRemoteHost();
    const first = await bootstrapRemoteServer(bootstrapInput(host));

    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
          probeHandshake: (credential) =>
            Promise.resolve({
              environmentId: ENVIRONMENT_ID,
              serverVersion: "0.6.3",
              acceptedToken: credential.token,
              authenticated: true,
            }),
        }),
      ),
    ).rejects.toThrow(/not the one running/);

    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
    expect(host.readFile(layout.credentialFile)?.trim()).toBe(first.credential.token);
  });
});
