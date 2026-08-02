// FILE: tailscaleServe.ts
// Purpose: Detect whether a host can be reached over Tailscale with HTTPS, and
//          derive the pairing origin for the blessed phone path.
// Layer: Shared runtime (parsing only — process execution is the caller's job)
// Exports: status parsing, serve-config parsing, and pairing-path resolution.

/**
 * What a phone can actually use to reach a Synara server, best first.
 *
 * - `tailscale-serve`: HTTPS directly to the host over the tailnet. The blessed
 *   path: no port forward to hold open, works with the laptop asleep, and the
 *   certificate is real so the browser does not warn.
 * - `ssh-port-forward`: the always-works fallback. Requires a machine holding
 *   the forward, so it dies with the laptop — correct, but not the default.
 */
export type PhoneReachabilityKind = "tailscale-serve" | "ssh-port-forward";

export interface TailscaleStatus {
  /** `tailscale` is installed and this machine is logged in to a tailnet. */
  readonly online: boolean;
  /** Fully-qualified MagicDNS name, e.g. `vps.tail1234.ts.net`. */
  readonly dnsName: string | null;
  /** HTTPS certificates enabled for the tailnet (`serve` needs them). */
  readonly httpsAvailable: boolean;
}

const OFFLINE_STATUS: TailscaleStatus = {
  online: false,
  dnsName: null,
  httpsAvailable: false,
};

/** `tailscale status --json` shape, narrowed to the fields we read. */
interface RawTailscaleStatus {
  readonly BackendState?: unknown;
  readonly Self?: { readonly DNSName?: unknown; readonly Online?: unknown };
  readonly CertDomains?: unknown;
}

/**
 * Parses `tailscale status --json`.
 *
 * Fails CLOSED: anything unparseable, any non-`Running` backend, or a missing
 * DNS name reports offline. Reporting a Tailscale path that does not work would
 * send the user down a dead end and hide the fallback that always works.
 */
export function parseTailscaleStatus(rawJson: string): TailscaleStatus {
  let parsed: RawTailscaleStatus;
  try {
    parsed = JSON.parse(rawJson) as RawTailscaleStatus;
  } catch {
    return OFFLINE_STATUS;
  }
  if (typeof parsed !== "object" || parsed === null) return OFFLINE_STATUS;
  if (parsed.BackendState !== "Running") return OFFLINE_STATUS;

  const rawDnsName = parsed.Self?.DNSName;
  if (typeof rawDnsName !== "string") return OFFLINE_STATUS;
  // MagicDNS names carry a trailing dot; a URL built from one is still valid but
  // does not match the certificate's subject, so it is normalised away here.
  const dnsName = rawDnsName.replace(/\.$/, "");
  if (dnsName.length === 0) return OFFLINE_STATUS;

  const certDomains = Array.isArray(parsed.CertDomains) ? parsed.CertDomains : [];
  const httpsAvailable = certDomains.some(
    (domain) => typeof domain === "string" && domain.replace(/\.$/, "") === dnsName,
  );

  return { online: true, dnsName, httpsAvailable };
}

export interface TailscaleServeMapping {
  /** Public HTTPS port on the tailnet. */
  readonly port: number;
  /** Local target the mapping proxies to, e.g. `http://127.0.0.1:1596`. */
  readonly target: string;
}

interface RawServeConfig {
  readonly Web?: Readonly<
    Record<string, { readonly Handlers?: Readonly<Record<string, { readonly Proxy?: unknown }>> }>
  >;
}

/**
 * Parses `tailscale serve status --json` into the HTTPS mappings it declares.
 *
 * Keys look like `vps.tail1234.ts.net:443`; only the port is needed here
 * because the caller already knows which host it asked about.
 */
export function parseTailscaleServeMappings(rawJson: string): readonly TailscaleServeMapping[] {
  let parsed: RawServeConfig;
  try {
    parsed = JSON.parse(rawJson) as RawServeConfig;
  } catch {
    return [];
  }
  const web = parsed?.Web;
  if (typeof web !== "object" || web === null) return [];

  const mappings: TailscaleServeMapping[] = [];
  for (const [hostPort, entry] of Object.entries(web)) {
    const port = Number.parseInt(hostPort.slice(hostPort.lastIndexOf(":") + 1), 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
    for (const handler of Object.values(entry?.Handlers ?? {})) {
      if (typeof handler?.Proxy !== "string" || handler.Proxy.length === 0) continue;
      mappings.push({ port, target: handler.Proxy });
    }
  }
  return mappings;
}

/** Does any serve mapping forward to the port Synara listens on? */
export function serveMappingForLocalPort(
  mappings: readonly TailscaleServeMapping[],
  localPort: number,
): TailscaleServeMapping | null {
  return (
    mappings.find((mapping) => {
      try {
        return new URL(mapping.target).port === String(localPort);
      } catch {
        return false;
      }
    }) ?? null
  );
}

export interface PhoneReachability {
  readonly kind: PhoneReachabilityKind;
  /** HTTPS origin a phone should open. Null for the port-forward fallback. */
  readonly origin: string | null;
  /** One-line explanation shown next to the QR code. */
  readonly summary: string;
  /** What the user must do to make this path work, when anything is missing. */
  readonly setupHint: string | null;
}

const PORT_FORWARD_SUMMARY =
  "Reachable only while an SSH port forward is open from a machine that stays awake.";

/**
 * Chooses the reachability path to offer for a host.
 *
 * Tailscale is offered ONLY when it can actually serve HTTPS on this port right
 * now. A half-configured tailnet falls back rather than showing a URL that will
 * not load — an unreachable QR code is worse than no QR code, because the user
 * blames their phone.
 */
export function resolvePhoneReachability(input: {
  readonly status: TailscaleStatus;
  readonly serveMappings: readonly TailscaleServeMapping[];
  readonly localPort: number;
}): PhoneReachability {
  const { status } = input;
  if (!status.online || !status.dnsName) {
    return {
      kind: "ssh-port-forward",
      origin: null,
      summary: PORT_FORWARD_SUMMARY,
      setupHint:
        "Install Tailscale on this host and run `tailscale up` to pair phones over HTTPS with no forward to hold open.",
    };
  }
  if (!status.httpsAvailable) {
    return {
      kind: "ssh-port-forward",
      origin: null,
      summary: PORT_FORWARD_SUMMARY,
      setupHint:
        "Enable HTTPS certificates for your tailnet in the Tailscale admin console, then run `tailscale serve` here to pair phones directly.",
    };
  }
  const mapping = serveMappingForLocalPort(input.serveMappings, input.localPort);
  if (!mapping) {
    return {
      kind: "ssh-port-forward",
      origin: null,
      summary: PORT_FORWARD_SUMMARY,
      setupHint: `Run \`tailscale serve --bg ${input.localPort}\` on this host to reach it at https://${status.dnsName} from your phone.`,
    };
  }
  const origin =
    mapping.port === 443
      ? `https://${status.dnsName}`
      : `https://${status.dnsName}:${mapping.port}`;
  return {
    kind: "tailscale-serve",
    origin,
    summary: `Reachable at ${origin} from any device on your tailnet, even with your laptop asleep.`,
    setupHint: null,
  };
}

/** The always-works fallback, spelled out for in-product documentation. */
export function sshPortForwardCommand(input: {
  readonly sshDestination: string;
  readonly localPort: number;
  readonly remotePort: number;
}): string {
  return `ssh -N -L ${input.localPort}:127.0.0.1:${input.remotePort} ${input.sshDestination}`;
}
