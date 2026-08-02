import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import type { RemoteHostConfig } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { RemoteHostConfigError } from "./remoteCommand";
import {
  buildSshKeyscanArgv,
  buildSshResolveArgv,
  parseHostKeyFingerprints,
  parseResolvedSshTarget,
  preferredHostKey,
} from "./remoteHostFingerprint";

function makeConfig(overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig {
  return {
    hostId: "host-1",
    label: "Devbox",
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

// A real ed25519 host key, generated once and pasted here, so the fingerprint
// assertions below are checked against openssh's own output rather than against
// a value this module produced.
const ED25519_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIB2xUxKC1PfLTBFN0PjXqPQjX3TxCr7O0mJl0hDxWNqK";
const RSA_KEY_PREFIX = "AAAAB3NzaC1yc2EAAAADAQABAAABgQC";

describe("buildSshResolveArgv", () => {
  it("asks ssh to resolve without connecting, and ends option parsing", () => {
    const { command, args } = buildSshResolveArgv(makeConfig());
    expect(command).toBe("ssh");
    expect(args).toEqual(["-G", "--", "devbox"]);
  });

  it("honours a configured ssh binary", () => {
    const { command } = buildSshResolveArgv(makeConfig({ sshBinary: "/opt/bin/ssh" }));
    expect(command).toBe("/opt/bin/ssh");
  });

  it("refuses a destination the shared config gate would refuse", () => {
    expect(() => buildSshResolveArgv(makeConfig({ destination: "-oProxyCommand=touch /tmp/x" }))).toThrow(
      RemoteHostConfigError,
    );
  });

  it("never builds a shell string", () => {
    // The argv array is the safety property: no element is ever concatenated
    // into a command line, so no destination can carry syntax.
    const { args } = buildSshResolveArgv(makeConfig({ destination: "weird.host.example.com" }));
    expect(Array.isArray(args)).toBe(true);
    for (const arg of args) expect(typeof arg).toBe("string");
  });
});

describe("parseResolvedSshTarget", () => {
  it("reads hostname and port from ssh -G output", () => {
    const target = parseResolvedSshTarget(
      ["user root", "hostname 10.0.0.4", "port 2222", "addressfamily any"].join("\n"),
    );
    expect(target).toEqual({ hostname: "10.0.0.4", port: 2222 });
  });

  it("defaults the port to 22 when ssh does not report a usable one", () => {
    expect(parseResolvedSshTarget("hostname build-box").port).toBe(22);
    expect(parseResolvedSshTarget("hostname build-box\nport not-a-number").port).toBe(22);
    expect(parseResolvedSshTarget("hostname build-box\nport 99999").port).toBe(22);
  });

  it("takes the FIRST value for a key, matching ssh's own precedence", () => {
    // Reporting the last value would show the user a different machine than ssh
    // is going to dial.
    const target = parseResolvedSshTarget(
      ["hostname real.example.com", "hostname later.example.com", "port 22"].join("\n"),
    );
    expect(target.hostname).toBe("real.example.com");
  });

  it("refuses a resolved hostname that could be read as an ssh-keyscan option", () => {
    // ssh-keyscan has no `--`, so a dashed hostname would become a flag.
    expect(() => parseResolvedSshTarget("hostname -oProxyCommand=x")).toThrow(RemoteHostConfigError);
  });

  it("fails loudly when ssh reported no hostname at all", () => {
    expect(() => parseResolvedSshTarget("user root\nport 22")).toThrow(RemoteHostConfigError);
  });
});

describe("buildSshKeyscanArgv", () => {
  it("builds an argv array with an explicit timeout and port", () => {
    const { command, args } = buildSshKeyscanArgv({ hostname: "10.0.0.4", port: 2222 });
    expect(command).toBe("ssh-keyscan");
    expect(args).toEqual(["-T", "8", "-p", "2222", "10.0.0.4"]);
    // The hostname is last, so it can never be consumed as a value flag's argument.
    expect(args.at(-1)).toBe("10.0.0.4");
  });

  it("always carries a timeout, so a silent host cannot hang the dialog", () => {
    const { args } = buildSshKeyscanArgv({ hostname: "h", port: 22 });
    expect(args).toContain("-T");
  });

  it("refuses a dashed hostname and an out-of-range port", () => {
    expect(() => buildSshKeyscanArgv({ hostname: "-h", port: 22 })).toThrow(RemoteHostConfigError);
    expect(() => buildSshKeyscanArgv({ hostname: "h", port: 0 })).toThrow(RemoteHostConfigError);
    expect(() => buildSshKeyscanArgv({ hostname: "h", port: 70_000 })).toThrow(
      RemoteHostConfigError,
    );
  });
});

describe("parseHostKeyFingerprints", () => {
  it("computes the SAME fingerprint openssh does", () => {
    // The security claim of this module is that the string we show a user is the
    // string `ssh-keygen -lf` shows on the host. Anything less is a number that
    // merely looks like a fingerprint, so it is checked against the real tool.
    const dir = mkdtempSync(Path.join(tmpdir(), "synara-fingerprint-"));
    try {
      const keyPath = Path.join(dir, "host.pub");
      writeFileSync(keyPath, `ssh-ed25519 ${ED25519_KEY} test\n`);
      const expected = execFileSync("ssh-keygen", ["-lf", keyPath], { encoding: "utf8" });
      const [parsed] = parseHostKeyFingerprints(`build-box ssh-ed25519 ${ED25519_KEY}`);
      expect(parsed).toBeDefined();
      expect(expected).toContain(parsed?.fingerprint as string);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders SHA256: with base64 padding stripped", () => {
    const [parsed] = parseHostKeyFingerprints(`build-box ssh-ed25519 ${ED25519_KEY}`);
    expect(parsed?.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(parsed?.fingerprint).not.toContain("=");
    expect(parsed?.displayType).toBe("ed25519");
  });

  it("skips the banner comment ssh-keyscan interleaves", () => {
    const parsed = parseHostKeyFingerprints(
      [
        "# build-box:22 SSH-2.0-OpenSSH_9.6",
        `build-box ssh-ed25519 ${ED25519_KEY}`,
        "# build-box:22 SSH-2.0-OpenSSH_9.6",
      ].join("\n"),
    );
    expect(parsed).toHaveLength(1);
  });

  it("drops lines that are not a recognised key rather than guessing", () => {
    const parsed = parseHostKeyFingerprints(
      [
        "build-box not-a-key-type AAAA",
        `build-box ssh-ed25519 not!valid!base64`,
        "build-box ssh-ed25519",
        "",
        `build-box ssh-ed25519 ${ED25519_KEY}`,
      ].join("\n"),
    );
    // Only the well-formed line survives: a malformed line must never become a
    // fingerprint a user then "verifies" against their server.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.keyType).toBe("ssh-ed25519");
  });

  it("keeps only the first key of each type", () => {
    const parsed = parseHostKeyFingerprints(
      [`build-box ssh-ed25519 ${ED25519_KEY}`, `build-box ssh-ed25519 ${ED25519_KEY}`].join("\n"),
    );
    expect(parsed).toHaveLength(1);
  });

  it("returns nothing for empty output instead of a placeholder", () => {
    expect(parseHostKeyFingerprints("")).toEqual([]);
    expect(parseHostKeyFingerprints("# banner only")).toEqual([]);
  });
});

describe("preferredHostKey", () => {
  it("prefers ed25519 over RSA regardless of scan order", () => {
    const rsaKey = `${RSA_KEY_PREFIX}${"A".repeat(340)}`;
    const parsed = parseHostKeyFingerprints(
      [`h ssh-rsa ${rsaKey}`, `h ssh-ed25519 ${ED25519_KEY}`].join("\n"),
    );
    expect(preferredHostKey(parsed)?.keyType).toBe("ssh-ed25519");
  });

  it("is undefined when there is nothing to show", () => {
    expect(preferredHostKey([])).toBeUndefined();
  });
});
