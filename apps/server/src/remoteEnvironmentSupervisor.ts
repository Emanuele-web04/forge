// FILE: remoteEnvironmentSupervisor.ts
// Purpose: Watch the saved remote hosts and keep the set of PUBLISHED remote
//          environments matching it — bringing each host up through the
//          pipeline, tearing it down when it is removed, and reporting where
//          every host got to.
// Layer: Server / remote broker
// Exports: RemoteEnvironmentSupervisor, makeRemoteEnvironmentSupervisor
//
// The thing this closes
// ---------------------
// Adding a host wrote a RemoteHostConfig into ServerSettings.remoteHosts and
// nothing observed that write. Every component below existed and was tested;
// none of them had a production caller. This is the observer: settings change →
// pipeline → proxy → (client, via the status stream).
//
// Failure policy
// --------------
// A host that fails is a STATUS, never a throw that escapes the supervisor. One
// unreachable laptop must not stop the other hosts from coming up, and a host
// that fails forever must back off rather than spin — so retries reuse
// `backoffDelayMs`, the same jittered curve the connectivity state machine
// uses, instead of a second schedule that would double a "quiet" host's rate.

import { homedir } from "node:os";

import type { RemoteEnvironmentStatus, RemoteHostConfig, RemoteHostId } from "@synara/contracts";

import type { BootstrapProgress } from "./remoteBootstrap/remoteBootstrap";
import {
  bringUpRemoteEnvironment,
  RemoteEnvironmentUnsupportedError,
  type RemoteEnvironmentBringUp,
} from "./remoteBootstrap/remoteEnvironmentPipeline";
import { resolveBootstrapArtifactSet } from "./remoteBootstrap/bootstrapArtifactSource";
import type { RemoteHostFacts } from "./remoteBootstrap/remoteHostFacts";
import { remoteArtifactTargetFor } from "./remoteBootstrap/remoteHostFacts";
import type { BootstrapArtifactAvailability } from "./remoteBootstrap/bootstrapArtifactSource";
import {
  connectionIdentityOf,
  failedStatus,
  planSupervisedHosts,
  statusFor,
  unsupportedStatus,
} from "./remoteBootstrap/remoteEnvironmentSupervisorState";

/** Where a host's Synara is installed, derived from the remote's own home. */
const INSTALL_SUBPATH = ".synara/remote";

export interface RemoteEnvironmentSupervisorOptions {
  readonly controlDirectory?: string | undefined;
  readonly now?: () => number;
  readonly random?: () => number;
  /**
   * Resolves the artifact set for a remote's architecture. Defaults to the
   * packaged manifests; injected in tests and by a caller that ships them
   * somewhere else.
   */
  readonly resolveArtifacts?: (facts: RemoteHostFacts) => Promise<BootstrapArtifactAvailability>;
  /** Test seam for the whole pipeline. */
  readonly bringUp?: typeof bringUpRemoteEnvironment;
  /** Notified whenever any host's status changes. */
  readonly onStatusesChanged?: (statuses: readonly RemoteEnvironmentStatus[]) => void;
  readonly onError?: (message: string, cause: unknown) => void;
  /** Overrides the install root; otherwise derived from the remote's home. */
  readonly installRootFor?: (config: RemoteHostConfig) => string;
}

interface SupervisedHost {
  readonly config: RemoteHostConfig;
  /** Identity of the config we brought this up with; a change forces a restart. */
  readonly identity: string;
  bringUp?: RemoteEnvironmentBringUp | undefined;
  /** Cancels a scheduled retry when the host is removed or restarted. */
  retryTimer?: ReturnType<typeof setTimeout> | undefined;
  attempt: number;
  /** Guards against a second run for the same host overlapping the first. */
  running: boolean;
  /** Set when the host was removed while its bring-up was still in flight. */
  abandoned: boolean;
}

export interface RemoteEnvironmentSupervisor {
  /** Reconciles the supervised set against the saved hosts. Never throws. */
  sync(hosts: readonly RemoteHostConfig[]): Promise<void>;
  statuses(): readonly RemoteEnvironmentStatus[];
  /** Tears down every environment. Idempotent. */
  dispose(): Promise<void>;
}

function defaultResolveArtifacts(facts: RemoteHostFacts): Promise<BootstrapArtifactAvailability> {
  const target = remoteArtifactTargetFor(facts);
  if (target === undefined) {
    return Promise.resolve({
      available: false,
      reason: `Synara has no remote build for ${facts.os}-${facts.arch}.`,
      searched: [],
    });
  }
  return resolveBootstrapArtifactSet({
    target,
    moduleDirectory: import.meta.dirname,
    ...(process.env.SYNARA_BOOTSTRAP_ARTIFACTS_DIR === undefined
      ? {}
      : { overrideDirectory: process.env.SYNARA_BOOTSTRAP_ARTIFACTS_DIR }),
  });
}

export function makeRemoteEnvironmentSupervisor(
  options: RemoteEnvironmentSupervisorOptions = {},
): RemoteEnvironmentSupervisor {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const bringUp = options.bringUp ?? bringUpRemoteEnvironment;
  const resolveArtifacts = options.resolveArtifacts ?? defaultResolveArtifacts;

  const supervised = new Map<RemoteHostId, SupervisedHost>();
  const statusByHost = new Map<RemoteHostId, RemoteEnvironmentStatus>();
  let disposed = false;

  const emit = (): void => {
    options.onStatusesChanged?.([...statusByHost.values()]);
  };

  const setStatus = (status: RemoteEnvironmentStatus): void => {
    statusByHost.set(status.hostId, status);
    emit();
  };

  const installRootFor = (config: RemoteHostConfig): string =>
    options.installRootFor?.(config) ??
    // The remote's own home, not ours. `~` is expanded by the REMOTE shell in
    // the bootstrapper's commands, so this stays a literal path built from the
    // facts the pipeline reads off the box.
    `${homedir().replace(/\/+$/, "")}/${INSTALL_SUBPATH}`;

  /**
   * Runs one attempt, recording where it got to.
   *
   * Everything is caught: a supervisor that lets a host's failure escape stops
   * observing settings, which takes every OTHER host down with it.
   */
  const attempt = async (entry: SupervisedHost): Promise<void> => {
    if (disposed || entry.abandoned || entry.running) return;
    entry.running = true;
    const hostId = entry.config.hostId;

    setStatus(statusFor({ hostId, phase: "probing", nowMs: now() }));

    try {
      const result = await bringUp({
        config: entry.config,
        installRoot: installRootFor(entry.config),
        ...(options.controlDirectory === undefined
          ? {}
          : { controlDirectory: options.controlDirectory }),
        resolveArtifacts,
        onProgress: (progress: BootstrapProgress) => {
          // Carried as the RAW step name; the client owns the copy. A step this
          // server has and the client has no approved string for renders
          // nothing rather than leaking an identifier into the UI.
          setStatus(
            statusFor({
              hostId,
              phase: "bootstrapping",
              nowMs: now(),
              bootstrapStep: progress.step,
            }),
          );
        },
        onLost: (detail: string) => {
          // The proxy already retracted before this fired, so the environment is
          // gone rather than 502-ing. Report it and schedule another attempt.
          if (disposed || entry.abandoned) return;
          entry.bringUp = undefined;
          entry.attempt += 1;
          setStatus(
            failedStatus({
              hostId,
              attempt: entry.attempt,
              error: detail,
              nowMs: now(),
              random,
            }),
          );
          scheduleRetry(entry);
        },
      });

      // Removed while we were working: unwind rather than publish an
      // environment for a host the user no longer has.
      if (disposed || entry.abandoned) {
        await result.close().catch(() => undefined);
        return;
      }

      entry.bringUp = result;
      entry.attempt = 0;
      setStatus(
        statusFor({
          hostId,
          phase: "ready",
          nowMs: now(),
          environmentId: result.environmentId,
        }),
      );
    } catch (cause) {
      if (disposed || entry.abandoned) return;
      if (cause instanceof RemoteEnvironmentUnsupportedError) {
        // Terminal. No retry is scheduled, because no number of attempts turns
        // a darwin host into a systemd one.
        setStatus(unsupportedStatus({ hostId, reason: cause.message, nowMs: now() }));
        return;
      }
      entry.attempt += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      options.onError?.(`Remote host ${entry.config.label} could not be brought up`, cause);
      setStatus(
        failedStatus({ hostId, attempt: entry.attempt, error: message, nowMs: now(), random }),
      );
      scheduleRetry(entry);
    } finally {
      entry.running = false;
    }
  };

  function scheduleRetry(entry: SupervisedHost): void {
    if (disposed || entry.abandoned) return;
    const status = statusByHost.get(entry.config.hostId);
    const delay = Math.max(0, (status?.retryAtMs ?? now()) - now());
    clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => {
      void attempt(entry);
    }, delay);
    // A pending retry must never hold the process open: the supervisor is
    // best-effort background work, and an unreachable host would otherwise keep
    // the server from exiting.
    entry.retryTimer.unref?.();
  }

  const teardown = async (entry: SupervisedHost): Promise<void> => {
    entry.abandoned = true;
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    const running = entry.bringUp;
    entry.bringUp = undefined;
    if (running) {
      await running.close().catch((cause: unknown) => {
        options.onError?.(`Failed to close remote environment for ${entry.config.label}`, cause);
      });
    }
  };

  return {
    async sync(hosts) {
      if (disposed) return;
      const running = new Map<RemoteHostId, string>(
        [...supervised].map(([hostId, entry]) => [hostId, entry.identity]),
      );
      const plan = planSupervisedHosts({ saved: hosts, running });

      // Stops first, so a host that was removed releases its port and its proxy
      // entry before a restarted one asks for them.
      for (const hostId of [...plan.stop, ...plan.restart.map((config) => config.hostId)]) {
        const entry = supervised.get(hostId);
        if (!entry) continue;
        supervised.delete(hostId);
        await teardown(entry);
        // A stopped host keeps no status: the row is gone from settings, so a
        // lingering "ready" would describe something that no longer exists.
        if (plan.restart.every((config) => config.hostId !== hostId)) {
          statusByHost.delete(hostId);
          emit();
        }
      }

      for (const config of [...plan.start, ...plan.restart]) {
        const entry: SupervisedHost = {
          config,
          identity: connectionIdentityOf(config),
          attempt: 0,
          running: false,
          abandoned: false,
        };
        supervised.set(config.hostId, entry);
        setStatus(statusFor({ hostId: config.hostId, phase: "idle", nowMs: now() }));
        // Deliberately NOT awaited: hosts come up in parallel, and one slow or
        // unreachable box must not delay every other host's bring-up.
        void attempt(entry);
      }
    },

    statuses() {
      return [...statusByHost.values()];
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      const entries = [...supervised.values()];
      supervised.clear();
      await Promise.all(entries.map((entry) => teardown(entry)));
      statusByHost.clear();
    },
  };
}
