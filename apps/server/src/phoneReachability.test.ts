// FILE: phoneReachability.test.ts
// Purpose: Proves the pairing screen always gets an answer — Tailscale when it
//          works, the documented SSH fallback in every other case.
// Layer: Server tests

import { describe, expect, it, vi } from "vitest";

import { detectPhoneReachability, type CommandRunner } from "./phoneReachability";

const STATUS_JSON = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "vps.tail1234.ts.net." },
  CertDomains: ["vps.tail1234.ts.net"],
});
const SERVE_JSON = JSON.stringify({
  Web: { "vps.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:1596" } } } },
});

function runnerFor(outputs: Readonly<Record<string, string>>): CommandRunner {
  return async (_command, args) => {
    const key = args.join(" ");
    const stdout = outputs[key];
    return stdout === undefined ? { stdout: "", code: 1 } : { stdout, code: 0 };
  };
}

describe("detectPhoneReachability", () => {
  it("reports the Tailscale origin when status and serve both line up", async () => {
    const report = await detectPhoneReachability({
      localPort: 1596,
      sshDestination: "me@vps",
      runner: runnerFor({
        "status --json": STATUS_JSON,
        "serve status --json": SERVE_JSON,
      }),
    });
    expect(report.kind).toBe("tailscale-serve");
    expect(report.origin).toBe("https://vps.tail1234.ts.net");
  });

  it("always includes the SSH fallback command, even on the Tailscale path", async () => {
    // The fallback matters most the moment the tailnet stops working, which is
    // the worst time to have to go and look it up.
    const report = await detectPhoneReachability({
      localPort: 1596,
      sshDestination: "me@vps",
      runner: runnerFor({
        "status --json": STATUS_JSON,
        "serve status --json": SERVE_JSON,
      }),
    });
    expect(report.fallbackCommand).toBe("ssh -N -L 1596:127.0.0.1:1596 me@vps");
  });

  it("falls back when `tailscale` is not installed rather than failing the screen", async () => {
    const report = await detectPhoneReachability({
      localPort: 1596,
      sshDestination: "me@vps",
      runner: async () => {
        throw new Error("Command not found: tailscale");
      },
    });
    expect(report.kind).toBe("ssh-port-forward");
    expect(report.setupHint).toContain("tailscale up");
    expect(report.fallbackCommand).toContain("ssh -N -L");
  });

  it("treats a non-zero exit as no information, not as valid output", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: STATUS_JSON, code: 1 }));
    const report = await detectPhoneReachability({
      localPort: 1596,
      sshDestination: "me@vps",
      runner,
    });
    // Stdout on a failing exit is untrustworthy: a partially-written document
    // would otherwise be read as a working tailnet.
    expect(report.kind).toBe("ssh-port-forward");
  });

  it("falls back when serve points at a different local port", async () => {
    const report = await detectPhoneReachability({
      localPort: 3000,
      sshDestination: "me@vps",
      runner: runnerFor({
        "status --json": STATUS_JSON,
        "serve status --json": SERVE_JSON,
      }),
    });
    expect(report.kind).toBe("ssh-port-forward");
    expect(report.setupHint).toContain("tailscale serve --bg 3000");
  });
});
