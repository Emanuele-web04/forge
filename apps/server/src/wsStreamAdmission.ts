import * as Crypto from "node:crypto";

import { WS_STREAM_LIMITS, WsRpcError } from "@synara/contracts";
import { Deferred, Effect, Ref, Stream } from "effect";

export const MAX_STREAMS_PER_RPC_CLIENT = WS_STREAM_LIMITS.totalPerClient;
export const MAX_THREAD_STREAMS_PER_RPC_CLIENT = WS_STREAM_LIMITS.threadPerClient;
const STREAM_CAPACITY_RETRY_AFTER_MS = 1_000;

export interface WsStreamSubscription {
  readonly key: string;
  readonly threadId?: string;
}

export interface WsStreamLease extends WsStreamSubscription {
  readonly clientId: number;
  readonly leaseId: string;
  // Resolves when a same-key resubscribe evicts this lease. Guarded streams
  // interrupt on it: removing the lease from the ledger alone would leave the
  // evicted stream's live tap running until its scope happens to finalize,
  // letting a resubscribing client hold more live streams than the caps allow.
  readonly evicted: Deferred.Deferred<void>;
}

interface ClientLedger {
  readonly leases: ReadonlyMap<string, WsStreamLease>;
}

interface AdmissionLedger {
  readonly clients: ReadonlyMap<number, ClientLedger>;
  readonly admittedTotal: number;
  readonly releasedTotal: number;
  readonly replacedDuplicateTotal: number;
  readonly rejectedCapacityTotal: number;
}

export interface WsStreamAdmissionSnapshot {
  readonly clients: number;
  readonly active: number;
  readonly admittedTotal: number;
  readonly releasedTotal: number;
  readonly replacedDuplicateTotal: number;
  readonly rejectedCapacityTotal: number;
}

type AdmissionOutcome =
  | {
      readonly _tag: "Admitted";
      readonly lease: WsStreamLease;
      readonly evictedLeases: readonly WsStreamLease[];
    }
  | {
      readonly _tag: "Rejected";
      readonly error: WsRpcError;
      readonly reason: "stream-capacity" | "thread-capacity";
      readonly active: number;
      readonly activeThreads: number;
    };

const initialLedger = (): AdmissionLedger => ({
  clients: new Map(),
  admittedTotal: 0,
  releasedTotal: 0,
  replacedDuplicateTotal: 0,
  rejectedCapacityTotal: 0,
});

function activeThreadCount(leases: ReadonlyMap<string, WsStreamLease>): number {
  return new Set(
    Array.from(leases.values()).flatMap((lease) =>
      lease.threadId === undefined ? [] : [lease.threadId],
    ),
  ).size;
}

export const makeWsStreamAdmission = (
  options: {
    readonly recordRejection?: (input: {
      readonly threadId?: string;
      readonly reason: "stream-capacity" | "thread-capacity";
      readonly errorCode: string;
      readonly active: number;
      readonly activeThreads: number;
    }) => Effect.Effect<void, never>;
  } = {},
) =>
  Effect.gen(function* () {
    const ledgerRef = yield* Ref.make<AdmissionLedger>(initialLedger());

    const acquire = (clientId: number, subscription: WsStreamSubscription) =>
      Effect.gen(function* () {
        const evicted = yield* Deferred.make<void>();
        const outcome = yield* Ref.modify(
          ledgerRef,
          (ledger): readonly [AdmissionOutcome, AdmissionLedger] => {
            const client = ledger.clients.get(clientId) ?? { leases: new Map() };
            // Last subscription wins: a resubscribe for the same key evicts the
            // prior lease instead of being rejected. Release timing of the old
            // stream depends on async scope finalization (unsubscribeThread is a
            // no-op), so rejecting duplicates made every fast resubscribe race
            // the old stream's teardown. The evicted stream is torn down through
            // its eviction latch below, and its own eventual release is a safe
            // no-op because its leaseId is no longer in the ledger.
            const retainedLeases = new Map<string, WsStreamLease>();
            const evictedLeases: WsStreamLease[] = [];
            for (const [leaseId, lease] of client.leases) {
              if (lease.key === subscription.key) evictedLeases.push(lease);
              else retainedLeases.set(leaseId, lease);
            }
            const active = retainedLeases.size;
            const activeThreads = activeThreadCount(retainedLeases);
            if (active >= MAX_STREAMS_PER_RPC_CLIENT) {
              return [
                {
                  _tag: "Rejected",
                  reason: "stream-capacity",
                  active,
                  activeThreads,
                  error: new WsRpcError({
                    message: "Streaming RPC capacity exceeded.",
                    code: "STREAM_CAPACITY_EXCEEDED",
                    retryable: true,
                    retryAfterMs: STREAM_CAPACITY_RETRY_AFTER_MS,
                  }),
                },
                { ...ledger, rejectedCapacityTotal: ledger.rejectedCapacityTotal + 1 },
              ];
            }
            if (
              subscription.threadId !== undefined &&
              activeThreads >= MAX_THREAD_STREAMS_PER_RPC_CLIENT
            ) {
              return [
                {
                  _tag: "Rejected",
                  reason: "thread-capacity",
                  active,
                  activeThreads,
                  error: new WsRpcError({
                    message: "Thread streaming RPC capacity exceeded.",
                    code: "THREAD_STREAM_CAPACITY_EXCEEDED",
                    retryable: true,
                    retryAfterMs: STREAM_CAPACITY_RETRY_AFTER_MS,
                  }),
                },
                { ...ledger, rejectedCapacityTotal: ledger.rejectedCapacityTotal + 1 },
              ];
            }

            const lease: WsStreamLease = {
              ...subscription,
              clientId,
              leaseId: Crypto.randomUUID(),
              evicted,
            };
            const nextLeases = new Map(retainedLeases);
            nextLeases.set(lease.leaseId, lease);
            const nextClients = new Map(ledger.clients);
            nextClients.set(clientId, { leases: nextLeases });
            return [
              { _tag: "Admitted", lease, evictedLeases },
              {
                ...ledger,
                clients: nextClients,
                admittedTotal: ledger.admittedTotal + 1,
                replacedDuplicateTotal: ledger.replacedDuplicateTotal + evictedLeases.length,
              },
            ];
          },
        );
        if (outcome._tag === "Admitted") {
          if (outcome.evictedLeases.length > 0) {
            yield* Effect.logWarning("Streaming RPC subscription replaced prior lease.").pipe(
              Effect.annotateLogs({
                key: subscription.key,
                replacedCount: outcome.evictedLeases.length,
                requestedThreadId: subscription.threadId ?? null,
              }),
            );
            // Tear the replaced streams down now: capacity accounting already
            // dropped them, so letting them keep streaming would break the
            // invariant that the ledger bounds live taps.
            yield* Effect.forEach(
              outcome.evictedLeases,
              (evictedLease) => Deferred.succeed(evictedLease.evicted, undefined),
              { discard: true },
            );
          }
          return outcome.lease;
        }
        yield* Effect.logWarning("Rejected streaming RPC admission.").pipe(
          Effect.annotateLogs({
            reason: outcome.reason,
            active: outcome.active,
            activeThreads: outcome.activeThreads,
            streamLimit: MAX_STREAMS_PER_RPC_CLIENT,
            threadLimit: MAX_THREAD_STREAMS_PER_RPC_CLIENT,
            requestedThreadId: subscription.threadId ?? null,
          }),
        );
        if (options.recordRejection) {
          const recordRejection = options.recordRejection;
          yield* Effect.sync(() => {
            Effect.runFork(
              recordRejection({
                ...(subscription.threadId ? { threadId: subscription.threadId } : {}),
                reason: outcome.reason,
                errorCode: outcome.error.code ?? "STREAM_ADMISSION_REJECTED",
                active: outcome.active,
                activeThreads: outcome.activeThreads,
              }),
            );
          });
        }
        return yield* Effect.fail(outcome.error);
      });

    const release = (lease: WsStreamLease) =>
      Ref.update(ledgerRef, (ledger) => {
        const client = ledger.clients.get(lease.clientId);
        if (!client?.leases.has(lease.leaseId)) return ledger;
        const nextLeases = new Map(client.leases);
        nextLeases.delete(lease.leaseId);
        const nextClients = new Map(ledger.clients);
        if (nextLeases.size === 0) nextClients.delete(lease.clientId);
        else nextClients.set(lease.clientId, { leases: nextLeases });
        return {
          ...ledger,
          clients: nextClients,
          releasedTotal: ledger.releasedTotal + 1,
        };
      });

    const guard = <A, E, R>(
      clientId: number,
      subscription: WsStreamSubscription,
      stream: Stream.Stream<A, E, R>,
    ): Stream.Stream<A, E | WsRpcError, R> =>
      Stream.unwrap(
        Effect.acquireRelease(acquire(clientId, subscription), release).pipe(
          // Eviction ends the stream gracefully (interruptWhen completes it on
          // latch success); scope finalization then runs the lease's release,
          // which is a no-op because the takeover already removed it.
          Effect.map((lease) => stream.pipe(Stream.interruptWhen(Deferred.await(lease.evicted)))),
        ),
      );

    const snapshot = Ref.get(ledgerRef).pipe(
      Effect.map(
        (ledger): WsStreamAdmissionSnapshot => ({
          clients: ledger.clients.size,
          active: Array.from(ledger.clients.values()).reduce(
            (total, client) => total + client.leases.size,
            0,
          ),
          admittedTotal: ledger.admittedTotal,
          releasedTotal: ledger.releasedTotal,
          replacedDuplicateTotal: ledger.replacedDuplicateTotal,
          rejectedCapacityTotal: ledger.rejectedCapacityTotal,
        }),
      ),
    );

    return { acquire, release, guard, snapshot } as const;
  });
