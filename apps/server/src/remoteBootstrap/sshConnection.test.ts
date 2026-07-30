import { describe, expect, it } from "vitest";

import type { RemoteExecOptions, RemoteExecResult } from "./remoteConnection";
import { createSshConnection, sshConnectionOptionArgv, type SshTarget } from "./sshConnection";

const target: SshTarget = { host: "build-01.example.test", user: "deploy" };

interface Invocation {
  readonly file: string;
  readonly argv: ReadonlyArray<string>;
  readonly options: RemoteExecOptions | undefined;
}

function recordingRun(result: Partial<RemoteExecResult> = {}): {
  readonly run: (
    file: string,
    argv: ReadonlyArray<string>,
    options: RemoteExecOptions | undefined,
  ) => Promise<RemoteExecResult>;
  readonly invocations: Array<Invocation>;
} {
  const invocations: Array<Invocation> = [];
  return {
    invocations,
    run: (file, argv, options) => {
      invocations.push({ file, argv, options });
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...result });
    },
  };
}

/** Asserts an invocation was recorded at `index` and returns it typed. */
function invocationAt(invocations: ReadonlyArray<Invocation>, index: number): Invocation {
  const invocation = invocations.at(index);
  expect(invocation).toBeDefined();
  if (!invocation) throw new Error("unreachable");
  return invocation;
}

describe("sshConnectionOptionArgv", () => {
  it("verifies host keys strictly by default", () => {
    expect(sshConnectionOptionArgv(target)).toContain("StrictHostKeyChecking=yes");
  });

  // Mutation guard: the single most dangerous change anyone could make to this
  // file. `accept-new` pins an unknown key once; `no` accepts a CHANGED key,
  // which is an active MITM.
  it("uses accept-new for trust-on-first-use, never no", () => {
    const argv = sshConnectionOptionArgv({ ...target, trustOnFirstUse: true });
    expect(argv).toContain("StrictHostKeyChecking=accept-new");
    expect(argv).not.toContain("StrictHostKeyChecking=no");
    expect(argv).not.toContain("StrictHostKeyChecking=off");
  });

  it("always emits StrictHostKeyChecking so ssh_config cannot weaken it", () => {
    const targets: ReadonlyArray<SshTarget> = [
      target,
      { ...target, trustOnFirstUse: true },
      { ...target, trustOnFirstUse: false },
    ];
    for (const candidate of targets) {
      const argv = sshConnectionOptionArgv(candidate);
      expect(argv.filter((token) => token.startsWith("StrictHostKeyChecking="))).toHaveLength(1);
    }
  });

  it("never disables host key checking through any other option", () => {
    const argv = sshConnectionOptionArgv({ ...target, trustOnFirstUse: true }).join(" ");
    expect(argv).not.toMatch(/UserKnownHostsFile=\/dev\/null/);
    expect(argv).not.toMatch(/CheckHostIP=no/);
    expect(argv).not.toMatch(/HostKeyAlgorithms=/);
  });

  it("runs non-interactively so a prompt cannot hang a bootstrap", () => {
    expect(sshConnectionOptionArgv(target)).toContain("BatchMode=yes");
  });

  it("passes an identity file by path with IdentitiesOnly", () => {
    const argv = sshConnectionOptionArgv({ ...target, identityFile: "/home/me/.ssh/id_ed25519" });
    expect(argv).toContain("IdentitiesOnly=yes");
    expect(argv).toContain("/home/me/.ssh/id_ed25519");
  });

  // Mutation guard: key material must never be an argument. Only a path is.
  it("has no field that could carry key material", () => {
    const keys = Object.keys({
      host: "",
      user: "",
      port: 0,
      identityFile: "",
      knownHostsFile: "",
      trustOnFirstUse: false,
    } satisfies Required<SshTarget>);
    for (const key of keys) {
      expect(key).not.toMatch(/privateKey|passphrase|password|secret/i);
    }
  });
});

describe("exec argv encoding", () => {
  it("encodes the argv as a single shell word list", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).exec(["ls", "-la", "/var/log"]);
    expect(invocationAt(invocations, 0).file).toBe("ssh");
    expect(invocationAt(invocations, 0).argv.at(-1)).toBe("ls -la /var/log");
  });

  // Mutation guard: this is the exact injection seam PR #467's shellInit had.
  // Removing the encoding turns a crafted path into remote code execution.
  it.each([
    ["a command separator", "/tmp/x; rm -rf /"],
    ["command substitution", "/tmp/$(id)"],
    ["a backtick", "/tmp/`id`"],
    ["a pipe", "/tmp/a | tee /tmp/b"],
    ["an ampersand", "/tmp/a && curl evil"],
    ["a newline", "/tmp/a\nrm -rf /"],
    ["a glob", "/tmp/*"],
    ["a variable", "/tmp/$HOME"],
    ["a quote", "/tmp/it's"],
  ])("quotes %s into one inert token", async (_label, hostile) => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).exec(["cat", hostile]);
    const encoded = invocationAt(invocations, 0).argv.at(-1) ?? "";
    expect(encoded.startsWith("cat '")).toBe(true);
    // Everything after `cat ` is a single-quoted token, so no metacharacter is
    // left where the remote shell could act on it.
    expect(encoded.slice(4)).toMatch(/^'(?:[^']|'\\'')*'$/);
  });

  it("passes stdin through rather than putting it in argv", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).exec(["cat"], { stdin: "s3cret-token" });
    expect(invocationAt(invocations, 0).options?.stdin).toBe("s3cret-token");
    expect(invocationAt(invocations, 0).argv.join(" ")).not.toContain("s3cret-token");
  });

  it("passes an explicit port to ssh and scp with the right flag", async () => {
    const { run, invocations } = recordingRun();
    const connection = createSshConnection({ ...target, port: 2222 }, run);
    await connection.exec(["true"]);
    expect(invocationAt(invocations, 0).argv).toContain("-p");
    await connection.uploadFile({ localPath: "/tmp/a", remotePath: "/tmp/b" });
    expect(invocationAt(invocations, 1).file).toBe("scp");
    expect(invocationAt(invocations, 1).argv).toContain("-P");
  });
});

describe("uploadFile", () => {
  it("writes to a temp path and renames, so a truncated file never lands", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).uploadFile({
      localPath: "/tmp/local.tar.gz",
      remotePath: "/remote/staging/local.tar.gz",
      mode: 0o700,
    });
    // The path is a "safe token", so quoting leaves it byte-identical here; the
    // hostile-path cases below are where the quoting actually shows.
    expect(invocationAt(invocations, 0).argv.at(-1)).toBe(
      "deploy@build-01.example.test:/remote/staging/local.tar.gz.partial",
    );
    expect(invocationAt(invocations, -1).argv.at(-1)).toBe(
      "mv -- /remote/staging/local.tar.gz.partial /remote/staging/local.tar.gz",
    );
  });

  it("chmods the temp path before it becomes the real one", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).uploadFile({
      localPath: "/tmp/node",
      remotePath: "/remote/staging/node",
      mode: 0o700,
    });
    const chmod = invocations.find((invocation) => invocation.argv.at(-1)?.startsWith("chmod"));
    expect(chmod?.argv.at(-1)).toBe("chmod 700 -- /remote/staging/node.partial");
  });

  it("throws instead of silently leaving a partial file when scp fails", async () => {
    const { run } = recordingRun({ exitCode: 1, stderr: "Permission denied" });
    await expect(
      createSshConnection(target, run).uploadFile({
        localPath: "/tmp/a",
        remotePath: "/remote/a",
      }),
    ).rejects.toThrow(/Failed to upload/);
  });
});

describe("known_hosts pinning cannot be neutered", () => {
  // The escape this closes: `accept-new` only means trust-on-FIRST-use if the
  // pin can persist. Pointed at a sink, nothing is ever recorded, so a changed
  // key never fails and a repeated MITM can capture the uploaded credential
  // and answer the handshake. The old "never disables" test never passed a
  // knownHostsFile at all, so it could not see this.
  it.each(["none", "None", "NONE", "/dev/null", "/dev/zero", "null", "nul", " none "])(
    "refuses knownHostsFile %j",
    (knownHostsFile) => {
      expect(() => sshConnectionOptionArgv({ ...target, knownHostsFile })).toThrow(
        /never be pinned/,
      );
    },
  );

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
  ])("refuses %s rather than emitting an empty option", (_label, knownHostsFile) => {
    expect(() => sshConnectionOptionArgv({ ...target, knownHostsFile })).toThrow(
      /must be a path|absolute path/,
    );
  });

  it.each(["/home/me/known hosts", "/home/me/kh\nUserKnownHostsFile=/dev/null", "relative/kh"])(
    "refuses a path that could split or forge an option: %j",
    (knownHostsFile) => {
      expect(() => sshConnectionOptionArgv({ ...target, knownHostsFile })).toThrow();
    },
  );

  it("accepts a real path", () => {
    const argv = sshConnectionOptionArgv({
      ...target,
      knownHostsFile: "/home/me/.ssh/known_hosts",
    });
    expect(argv).toContain("UserKnownHostsFile=/home/me/.ssh/known_hosts");
  });

  // Whatever a caller supplies, the emitted option must never name a sink.
  it("never emits a non-persistent known_hosts option", () => {
    const candidates: ReadonlyArray<SshTarget> = [
      target,
      { ...target, knownHostsFile: "/home/me/.ssh/known_hosts" },
      { ...target, knownHostsFile: "~/.ssh/known_hosts" },
    ];
    for (const candidate of candidates) {
      const argv = sshConnectionOptionArgv(candidate).join(" ");
      expect(argv).not.toMatch(/UserKnownHostsFile=(none|\/dev\/null)/i);
    }
  });
});

describe("scp remote path injection", () => {
  // Legacy scp runs a REMOTE SHELL over the target path. An install root
  // containing $(...) would execute there, so the path is both transferred over
  // SFTP (-s) and quoted in case the client ignores the flag.
  it("requests the sftp protocol rather than the legacy remote-shell copy", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).uploadFile({
      localPath: "/tmp/a",
      remotePath: "/remote/a",
    });
    expect(invocationAt(invocations, 0).argv).toContain("-s");
  });

  it.each([
    ["command substitution", "/remote/$(id)/a"],
    ["a backtick", "/remote/`id`/a"],
    ["a command separator", "/remote/a; rm -rf /"],
    ["a pipe", "/remote/a | tee /tmp/b"],
    ["an ampersand", "/remote/a && curl evil"],
    ["a space", "/remote/My Synara/a"],
    ["a quote", "/remote/it's/a"],
    ["a newline", "/remote/a\nrm -rf /"],
    ["a glob", "/remote/*"],
    ["a variable", "/remote/$HOME/a"],
  ])("renders %s as one inert token in the scp target", async (_label, remotePath) => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).uploadFile({ localPath: "/tmp/a", remotePath });

    const scpTarget = invocationAt(invocations, 0).argv.at(-1) ?? "";
    expect(scpTarget.startsWith("deploy@build-01.example.test:")).toBe(true);
    const encodedPath = scpTarget.slice("deploy@build-01.example.test:".length);
    // Single-quoted end to end, so no metacharacter survives where a remote
    // shell could act on it.
    expect(encodedPath).toMatch(/^'(?:[^']|'\\'')*'$/);
  });

  // The mv/chmod that finalize the upload go through exec, which quotes; this
  // pins that the hostile path never appears raw in ANY invocation.
  it("never lets a hostile path reach a command unquoted", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).uploadFile({
      localPath: "/tmp/a",
      remotePath: "/remote/$(id)/a",
      mode: 0o700,
    });
    for (const invocation of invocations) {
      const rendered = invocation.argv.join(" ");
      if (rendered.includes("$(id)")) {
        expect(rendered).toMatch(/'[^']*\$\(id\)[^']*'/);
      }
    }
  });
});

describe("a hostile host/user cannot become an ssh option", () => {
  // Verified against the real ssh binary: `ssh -oProxyCommand=touch\ /tmp/x
  // host cmd` creates /tmp/x on the LOCAL machine before any connection is
  // attempted, because OpenSSH parses a leading-dash destination as options.
  // This is the PR #20 class of bug (-F/dev/null, -oProxyCommand=, -S, -vtt);
  // SshTarget has no field that can carry a raw flag, so the only way one could
  // reach argv is smuggled through host or user.
  const hostileValues = [
    "-oProxyCommand=touch /tmp/pwned",
    "-oProxyCommand=id",
    "-F/dev/null",
    "-S/tmp/attacker.sock",
    "-vtt",
    "-i/tmp/attacker_key",
    "-oUserKnownHostsFile=/dev/null",
    "-oStrictHostKeyChecking=no",
    "--",
    "-",
    "host with space",
    "host;id",
    "host$(id)",
    "host\nid",
    "",
  ];

  it.each(hostileValues)("refuses host %j", (host) => {
    expect(() => createSshConnection({ ...target, host }, recordingRun().run)).toThrow(
      /Invalid remote host/,
    );
  });

  it.each(hostileValues)("refuses user %j", (user) => {
    expect(() => createSshConnection({ ...target, user }, recordingRun().run)).toThrow(
      /Invalid remote user/,
    );
  });

  it.each(["-oProxyCommand=id", "relative/key", "/path/with space", "", "   "])(
    "refuses identityFile %j",
    (identityFile) => {
      expect(() => sshConnectionOptionArgv({ ...target, identityFile })).toThrow(
        /identity file|absolute path/i,
      );
    },
  );

  it("accepts ordinary hosts, users, and identity files", () => {
    const connection = createSshConnection(
      {
        host: "build-01.example.test",
        user: "deploy_user-1",
        identityFile: "/home/me/.ssh/id_ed25519",
      },
      recordingRun().run,
    );
    expect(connection.describe).toBe("deploy_user-1@build-01.example.test");
  });

  // Defence in depth: even a value that somehow passed validation must sit
  // after `--`, where ssh can no longer read it as a flag.
  it("passes -- before the destination on every exec", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).exec(["true"]);
    const argv = invocationAt(invocations, 0).argv;
    const separator = argv.indexOf("--");
    const destination = argv.indexOf("deploy@build-01.example.test");
    expect(separator).toBeGreaterThanOrEqual(0);
    expect(destination).toBeGreaterThan(separator);
  });

  it("passes -- before the destination on upload too", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).uploadFile({
      localPath: "/tmp/a",
      remotePath: "/remote/a",
    });
    const argv = invocationAt(invocations, 0).argv;
    const separator = argv.indexOf("--");
    expect(separator).toBeGreaterThanOrEqual(0);
    expect(argv.slice(separator + 1).some((token) => token.includes("@"))).toBe(true);
  });
});
