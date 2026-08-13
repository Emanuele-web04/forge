import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AccountHostEndpoint } from "@synara/contracts";

const execFileAsync = promisify(execFile);

type Runner = (args: readonly string[]) => Promise<string>;

const defaultRunner: Runner = async (args) => {
  try {
    const result = await execFileAsync("tailscale", [...args], {
      timeout: 2_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return result.stdout;
  } catch {
    return "";
  }
};

/** Reports Tailscale only when HTTPS Serve is currently mapped to this server port. */
export async function resolveTailscaleEndpoint(
  localPort: number,
  runner: Runner = defaultRunner,
): Promise<AccountHostEndpoint | undefined> {
  const [statusRaw, serveRaw] = await Promise.all([
    runner(["status", "--json"]),
    runner(["serve", "status", "--json"]),
  ]);
  try {
    const status = JSON.parse(statusRaw) as {
      BackendState?: unknown;
      Self?: { DNSName?: unknown; Online?: unknown };
      CertDomains?: unknown;
    };
    const dnsName =
      typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : "";
    const certDomains = Array.isArray(status.CertDomains) ? status.CertDomains : [];
    if (
      status.BackendState !== "Running" ||
      status.Self?.Online === false ||
      !dnsName ||
      !certDomains.some(
        (domain) => typeof domain === "string" && domain.replace(/\.$/, "") === dnsName,
      )
    ) {
      return undefined;
    }
    const serve = JSON.parse(serveRaw) as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
    };
    for (const [hostPort, entry] of Object.entries(serve.Web ?? {})) {
      for (const handler of Object.values(entry.Handlers ?? {})) {
        if (typeof handler.Proxy !== "string") continue;
        const target = new URL(handler.Proxy);
        if (Number(target.port || (target.protocol === "https:" ? 443 : 80)) !== localPort)
          continue;
        const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
        if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
        return {
          url: port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`,
          transport: "tailscale",
        };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
