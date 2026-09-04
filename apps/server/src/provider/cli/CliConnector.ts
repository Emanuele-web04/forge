// FILE: CliConnector.ts
// Purpose: KAR-527 generic CLI connector tier-dispatch service. Routes an
// external-agent profile revision to the structured or basic tier based on its
// ConnectorKind, maps launch specs to runtime spawn inputs, and derives the
// honest capability surface for each tier:
//   - structured: the capabilities the wire protocol itself can express
//     (session.start, prompt, stream, cancel); everything else is absent by
//     construction and never claimed.
//   - basic: session.start, prompt, stream, cancel — but cancel is only
//     "process-tree stop", never a protocol ack, and the connector never fakes
//     resume / permissions / elicitation / usage / tool events / model
//     discovery/switch / modes / terminal state (AC #2 honest limits).
// No Synara provider-name knowledge lives here; declarations are protocol- or
// tier-derived only. Dispatch is by `ConnectorKind`, so `acp` profiles never
// route here (coexistence with the ACP runtime).
// Layer: Server CLI connector dispatch
// Exports: CliConnector, makeCliConnector, isCliConnectorKind, CLI_TIER_BY_KIND

import { Effect, Layer, ServiceMap } from "effect";

import type { AgentProfileLaunch, ConnectorKind, ExternalAgentNamespace } from "@synara/contracts";
import { CapabilityId } from "@synara/contracts";

import type { CliStructuredSpawnInput, CliStructuredTier } from "./CliStructuredRuntime.ts";

/** The CLI-triggering connector kinds this connector owns. */
export const CLI_CONNECTOR_KINDS = [
  "cli-structured",
  "cli-basic",
] as const satisfies readonly ConnectorKind[];

/** Routes a `ConnectorKind` to a tier, or returns `undefined` for ACP/first-party. */
export const isCliConnectorKind = (
  kind: ConnectorKind,
): kind is (typeof CLI_CONNECTOR_KINDS)[number] =>
  CLI_CONNECTOR_KINDS.includes(kind as (typeof CLI_CONNECTOR_KINDS)[number]);

/** Maps a CLI connector kind to its tier. */
export const CLI_TIER_BY_KIND: Readonly<
  Record<(typeof CLI_CONNECTOR_KINDS)[number], CliStructuredTier>
> = {
  "cli-structured": "structured",
  "cli-basic": "basic",
};

/**
 * Canonical capability ids each tier can honestly provide.
 *
 * Structured is exactly the wire protocol surface: a hello, turn lifecycle
 * (start/text/completed/failed/cancelled), and a cancel command. Basic is the
 * plain-text surface: session start (first line), text streaming, and
 * cancellation via process-tree teardown. Every other capability is derived
 * absent and the connector refuses to advertise or emulate it (AC #2).
 */
export const CLI_TIER_CAPABILITY_IDS: Readonly<
  Record<CliStructuredTier, ReadonlyArray<CapabilityId>>
> = {
  structured: ["session.start", "prompt", "stream", "cancel"],
  basic: ["session.start", "prompt", "stream", "cancel"],
};

export interface CliConnectorShape {
  /** Maps a resolved launch spec to the CLI tier it belongs to. */
  readonly resolveTier: (input: {
    readonly connectorKind: ConnectorKind;
    readonly launch: AgentProfileLaunch;
  }) => CliStructuredTier | undefined;
  /**
   * Derives the honest capability surface for a tier. Structured may narrow
   * the set to what the wire hello advertised; basic is fixed.
   */
  readonly capabilityIdsForTier: (tier: CliStructuredTier) => ReadonlyArray<CapabilityId>;
  /** Builds the runtime spawn input from a resolved command launch. */
  readonly spawnInputForLaunch: (input: {
    readonly connectorKind: ConnectorKind;
    readonly launch: AgentProfileLaunch;
  }) => CliStructuredSpawnInput | undefined;
  /** The external-agent namespace a CLI profile belongs to. */
  readonly namespaceForKind: (connectorKind: ConnectorKind) => ExternalAgentNamespace | undefined;
}

export class CliConnector extends ServiceMap.Service<CliConnector, CliConnectorShape>()(
  "synara/provider/cli/CliConnector",
) {}

/** The external-agent namespace for a CLI profile (matches the ACP namespace scheme). */
const CLI_NAMESPACE_BY_KIND: Readonly<
  Partial<Record<(typeof CLI_CONNECTOR_KINDS)[number], ExternalAgentNamespace>>
> = {
  "cli-structured": "external.cli-structured",
  "cli-basic": "external.cli-basic",
};

export const makeCliConnector = Effect.gen(function* () {
  const resolveTier: CliConnectorShape["resolveTier"] = ({ connectorKind, launch }) => {
    if (!isCliConnectorKind(connectorKind) || launch.kind !== "command") {
      return undefined;
    }
    return CLI_TIER_BY_KIND[connectorKind];
  };

  const spawnInputForLaunch: CliConnectorShape["spawnInputForLaunch"] = ({
    connectorKind,
    launch,
  }) => {
    if (!isCliConnectorKind(connectorKind) || launch.kind !== "command") {
      return undefined;
    }
    return {
      command: launch.command,
      args: [...(launch.args ?? [])],
      ...(launch.cwd !== undefined && launch.cwd.length > 0 ? { cwd: launch.cwd } : {}),
    };
  };

  const service: CliConnectorShape = {
    resolveTier,
    capabilityIdsForTier: (tier) => [...(CLI_TIER_CAPABILITY_IDS[tier] ?? [])],
    spawnInputForLaunch,
    namespaceForKind: (connectorKind) =>
      isCliConnectorKind(connectorKind) ? CLI_NAMESPACE_BY_KIND[connectorKind] : undefined,
  };
  return service;
});

export const CliConnectorLive = Layer.effect(CliConnector, makeCliConnector);
