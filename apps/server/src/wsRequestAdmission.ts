import * as Crypto from "node:crypto";

import { ORCHESTRATION_WS_METHODS, WS_METHODS, WsRpcError } from "@synara/contracts";
import { Effect, Ref } from "effect";

export type WsRequestClass = "control" | "standard" | "expensive-read";

export const WS_REQUEST_CLASS_LIMITS: Readonly<Record<WsRequestClass, number>> = {
  control: 16,
  standard: 12,
  "expensive-read": 2,
};

const CONTROL_METHODS = new Set<string>([
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  ORCHESTRATION_WS_METHODS.reconcileProviderDelivery,
  WS_METHODS.terminalWrite,
  WS_METHODS.terminalAckOutput,
  WS_METHODS.terminalResize,
  WS_METHODS.terminalClose,
  WS_METHODS.serverStopLocalServer,
  WS_METHODS.automationCancelRun,
  WS_METHODS.automationMarkRunRead,
  WS_METHODS.automationArchiveRun,
]);

const EXPENSIVE_READ_METHODS = new Set<string>([
  ORCHESTRATION_WS_METHODS.getSnapshot,
  ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
  ORCHESTRATION_WS_METHODS.repairState,
  ORCHESTRATION_WS_METHODS.getTurnDiff,
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_WS_METHODS.replayEvents,
  ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.projectsSearchLocalEntries,
  WS_METHODS.projectsReadFile,
  WS_METHODS.studioListThreadOutputs,
  WS_METHODS.filesystemBrowse,
  WS_METHODS.gitStatus,
  WS_METHODS.gitReadWorkingTreeDiff,
  WS_METHODS.gitWorkingTreeDiffStats,
  WS_METHODS.gitSummarizeDiff,
  WS_METHODS.gitPullRequestSnapshot,
  WS_METHODS.serverGetProviderUsageSnapshot,
  WS_METHODS.serverListProviderUsage,
  WS_METHODS.serverGetDiagnostics,
  WS_METHODS.serverPrewarmVoice,
  WS_METHODS.serverGenerateThreadRecap,
  WS_METHODS.serverGenerateAutomationIntent,
  WS_METHODS.serverTranscribeVoice,
  WS_METHODS.statsGetProfileStats,
  WS_METHODS.statsGetProfileTokenStats,
  WS_METHODS.providerCompactThread,
  WS_METHODS.providerListCommands,
  WS_METHODS.providerListSkills,
  WS_METHODS.providerListSkillsCatalog,
  WS_METHODS.providerListPlugins,
  WS_METHODS.providerReadPlugin,
  WS_METHODS.providerListModels,
  WS_METHODS.providerListAgents,
]);

export function classifyWsRequest(method: string): WsRequestClass {
  if (CONTROL_METHODS.has(method)) return "control";
  if (EXPENSIVE_READ_METHODS.has(method)) return "expensive-read";
  return "standard";
}

export interface WsRequestLease {
  readonly clientId: number;
  readonly leaseId: string;
  readonly method: string;
  readonly requestClass: WsRequestClass;
}

interface AdmissionLedger {
  readonly clients: ReadonlyMap<number, ReadonlyMap<string, WsRequestLease>>;
  readonly admittedTotal: number;
  readonly releasedTotal: number;
  readonly rejectedTotal: number;
}

export interface WsRequestAdmissionSnapshot {
  readonly clients: number;
  readonly active: number;
  readonly admittedTotal: number;
  readonly releasedTotal: number;
  readonly rejectedTotal: number;
}

const initialLedger = (): AdmissionLedger => ({
  clients: new Map(),
  admittedTotal: 0,
  releasedTotal: 0,
  rejectedTotal: 0,
});

export const makeWsRequestAdmission = Effect.gen(function* () {
  const ledgerRef = yield* Ref.make<AdmissionLedger>(initialLedger());

  const acquire = (clientId: number, method: string) =>
    Ref.modify(
      ledgerRef,
      (ledger): readonly [Effect.Effect<WsRequestLease, WsRpcError>, AdmissionLedger] => {
        const requestClass = classifyWsRequest(method);
        const clientLeases = ledger.clients.get(clientId) ?? new Map<string, WsRequestLease>();
        const activeForClass = Array.from(clientLeases.values()).reduce(
          (count, lease) => count + (lease.requestClass === requestClass ? 1 : 0),
          0,
        );
        if (activeForClass >= WS_REQUEST_CLASS_LIMITS[requestClass]) {
          const code =
            requestClass === "expensive-read"
              ? "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED"
              : "RPC_REQUEST_CAPACITY_EXCEEDED";
          return [
            Effect.fail(
              new WsRpcError({
                message: `WebSocket ${requestClass} request capacity exceeded.`,
                code,
                retryable: true,
                retryAfterMs: 250,
              }),
            ),
            { ...ledger, rejectedTotal: ledger.rejectedTotal + 1 },
          ] as const;
        }

        const lease: WsRequestLease = {
          clientId,
          leaseId: Crypto.randomUUID(),
          method,
          requestClass,
        };
        const nextClientLeases = new Map(clientLeases);
        nextClientLeases.set(lease.leaseId, lease);
        const nextClients = new Map(ledger.clients);
        nextClients.set(clientId, nextClientLeases);
        return [
          Effect.succeed(lease),
          { ...ledger, clients: nextClients, admittedTotal: ledger.admittedTotal + 1 },
        ] as const;
      },
    ).pipe(Effect.flatten);

  const release = (lease: WsRequestLease) =>
    Ref.update(ledgerRef, (ledger) => {
      const clientLeases = ledger.clients.get(lease.clientId);
      if (!clientLeases?.has(lease.leaseId)) return ledger;
      const nextClientLeases = new Map(clientLeases);
      nextClientLeases.delete(lease.leaseId);
      const nextClients = new Map(ledger.clients);
      if (nextClientLeases.size === 0) nextClients.delete(lease.clientId);
      else nextClients.set(lease.clientId, nextClientLeases);
      return {
        ...ledger,
        clients: nextClients,
        releasedTotal: ledger.releasedTotal + 1,
      };
    });

  const guard = <A, E, R>(clientId: number, method: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(acquire(clientId, method), () => effect, release);

  const snapshot = Ref.get(ledgerRef).pipe(
    Effect.map(
      (ledger): WsRequestAdmissionSnapshot => ({
        clients: ledger.clients.size,
        active: Array.from(ledger.clients.values()).reduce(
          (total, leases) => total + leases.size,
          0,
        ),
        admittedTotal: ledger.admittedTotal,
        releasedTotal: ledger.releasedTotal,
        rejectedTotal: ledger.rejectedTotal,
      }),
    ),
  );

  return { acquire, release, guard, snapshot } as const;
});
