// FILE: remoteEnvironmentPipeline.ts
// Purpose: THE COMPOSITION. Takes one saved RemoteHostConfig and drives it all
//          the way to a published environment the browser can reach: probe →
//          bootstrap → tunnel → handshake → publish.
// Layer: Server / remote broker
// Exports: bringUpRemoteEnvironment, RemoteEnvironmentBringUp,
//          RemoteEnvironmentUnsupportedError
//
// This file exists because every piece below it was built, tested, and had zero
// production callers. The modules were never the gap; the WIRE between them
// was. So the only thing here is ordering, and the invariants that ordering has
// to hold:
//
//  1. NOTHING is published to the proxy before the handshake has passed. That
//     order lives in `openRemoteEnvironmentSession` and is not re-implemented.
//  2. The environmentId is the one the BOOTSTRAP provisioned and the handshake
//     echoed back. It is never generated here, and never accepted from a
//     client.
//  3. A host we cannot supervise (darwin) fails as a STRUCTURED reason, before
//     anything is uploaded — not as an obscure systemd error halfway through.
//  4. Every failure unwinds what it got through. Partial state that outlives a
//     failed attempt is what makes the next attempt behave differently from the
//     first.

import type { EnvironmentId, RemoteHostConfig } from "@synara/contracts";

import type { BootstrapArtifactSet } from "./bootstrapArtifacts";
import type { BootstrapProgress } from "./remoteBootstrap";
import { bootstrapRemoteServer, readRemoteReleaseId } from "./remoteBootstrap";
import type { RemoteConnection } from "./remoteConnection";
import { createRemoteHostConnection } from "./remoteHostConnection";
import {
  deriveRemoteServerPort,
  readRemoteHostFacts,
  remoteArtifactTargetFor,
  type RemoteHostFacts,
} from "./remoteHostFacts";
import { remoteInstallLayout, remoteCurrentNodePath } from "./remoteInstallLayout";
import {
  openRemoteEnvironmentSession,
  type RemoteEnvironmentSession,
} from "./remoteEnvironmentSession";
import { remoteSupervisorPlan, supervisorCapability } from "./remoteSupervisor";
import { probeHandshakeOverTunnel } from "./handshakeProbe";
import type { RemoteCredential } from "./provisioningHandshake";
import type { BootstrapArtifactAvailability } from "./bootstrapArtifactSource";

/** A host that can never work as configured. Never retried. */
export class RemoteEnvironmentUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteEnvironmentUnsupportedError";
  }
}

export interface RemoteEnvironmentBringUp {
  readonly environmentId: EnvironmentId;
  readonly session: RemoteEnvironmentSession;
  readonly releaseId: string;
  /** Tears down the published environment and the tunnel, in that order. */
  close(): Promise<void>;
}

export interface BringUpRemoteEnvironmentInput {
  readonly config: RemoteHostConfig;
  /** Absolute install root on the remote. */
  readonly installRoot: string;
  readonly controlDirectory?: string | undefined;
  /**
   * Resolves the artifact set for the remote's architecture. Injected because
   * "there are no artifacts in a dev checkout" is a normal, reportable state
   * that the caller renders, not an exception this file invents a policy for.
   */
  readonly resolveArtifacts: (facts: RemoteHostFacts) => Promise<BootstrapArtifactAvailability>;
  readonly onProgress?: (progress: BootstrapProgress) => void;
  /** Fires when a healthy tunnel dies on its own, after the proxy retracted. */
  readonly onLost?: (detail: string) => void;
  /** Test seams. */
  readonly createConnection?: (input: {
    readonly config: RemoteHostConfig;
    readonly controlDirectory?: string | undefined;
  }) => RemoteConnection;
  readonly openSession?: typeof openRemoteEnvironmentSession;
}

/**
 * The environment id for an install.
 *
 * Read from the host when one is already there, so a re-bootstrap of an
 * existing install keeps the id its threads are already filed under. Generated
 * only for a genuinely first install — and even then the value that MATTERS is
 * the one the handshake echoes back, which is what gets published.
 */
async function resolveEnvironmentId(
  connection: RemoteConnection,
  environmentIdFile: string,
): Promise<string> {
  const result = await connection.exec(["cat", "--", environmentIdFile]);
  const existing = result.exitCode === 0 ? result.stdout.trim() : "";
  return existing.length > 0 ? existing : crypto.randomUUID();
}

/**
 * Brings one host up.
 *
 * Reads the host's own facts first: the artifact set is architecture-specific
 * and the supervisor is OS-specific, so both are decided from what the box
 * actually is rather than from what the local machine is.
 */
export async function bringUpRemoteEnvironment(
  input: BringUpRemoteEnvironmentInput,
): Promise<RemoteEnvironmentBringUp> {
  const connection = (input.createConnection ?? createRemoteHostConnection)({
    config: input.config,
    ...(input.controlDirectory === undefined ? {} : { controlDirectory: input.controlDirectory }),
  });

  const facts = await readRemoteHostFacts(connection);

  // Refused BEFORE anything is uploaded. A darwin host can render a launchd
  // plist but the install flow is not wired end to end, and discovering that
  // after copying a Node runtime over a WAN wastes the transfer and leaves a
  // half-install behind.
  const capability = supervisorCapability(facts.os);
  if (!capability.supported) {
    throw new RemoteEnvironmentUnsupportedError(
      capability.reason ?? `Synara cannot supervise a ${facts.os} host yet.`,
    );
  }

  const target = remoteArtifactTargetFor(facts);
  if (target === undefined) {
    throw new RemoteEnvironmentUnsupportedError(
      `Synara has no remote build for ${facts.os}-${facts.arch}.`,
    );
  }

  const availability = await input.resolveArtifacts(facts);
  if (!availability.available) {
    // NOT an unsupported error: the host is fine, this BUILD has no artifacts.
    // Retrying is meaningless until the build changes, but the distinction is
    // what lets the surface say "install a release build" instead of "this host
    // will never work".
    throw new Error(availability.reason);
  }
  const artifacts: BootstrapArtifactSet = availability.artifacts;

  const layout = remoteInstallLayout(input.installRoot);
  const port = deriveRemoteServerPort(layout.root);
  const environmentId = await resolveEnvironmentId(connection, layout.environmentIdFile);

  const supervisor = remoteSupervisorPlan({
    os: facts.os,
    layout,
    releaseId: artifacts.releaseId,
    nodePath: remoteCurrentNodePath(layout),
    entrypointPath: `${layout.root}/current/dist/index.mjs`,
    port,
    // Derived from the environment id so two installs on one box cannot collide
    // on a unit name. Hyphens only: the instance id pattern refuses anything
    // else, and a uuid is already in that alphabet.
    instanceId: `env-${environmentId.replaceAll(/[^A-Za-z0-9-]/g, "")}`.slice(0, 64),
    homeDirectory: facts.homeDirectory,
    userId: facts.userId,
  });

  const installedReleaseId = await readRemoteReleaseId(connection, layout);

  let credential: RemoteCredential;
  let releaseId: string;
  let provisionedEnvironmentId: string;

  if (installedReleaseId === artifacts.releaseId) {
    // The release we would install is already live. Re-running the bootstrap
    // would restart a server that may be mid-turn for no gain, so this path
    // reuses the install — but it still has to obtain a credential, and the one
    // on the host is the only one that server accepts.
    const stored = await connection.exec(["cat", "--", layout.credentialFile]);
    const token = stored.exitCode === 0 ? stored.stdout.trim() : "";
    if (token.length === 0) {
      throw new Error(
        `The Synara install on ${connection.describe} has no credential; reinstall it to continue.`,
      );
    }
    credential = { token };
    releaseId = installedReleaseId;
    provisionedEnvironmentId = environmentId;
  } else {
    // A fresh install or an upgrade. The bootstrapper owns the whole sequence,
    // including its own handshake over a SHORT-LIVED tunnel: the server has to
    // be proven healthy before this function will hold a tunnel open for it.
    const outcome = await bootstrapRemoteServer({
      connection,
      layout,
      artifacts,
      supervisor,
      environmentId,
      probeHandshake: async (minted) => {
        const verifyTunnel = await openVerificationTunnel({
          config: input.config,
          remotePort: port,
          ...(input.controlDirectory === undefined
            ? {}
            : { controlDirectory: input.controlDirectory }),
        });
        try {
          return await probeHandshakeOverTunnel({
            localPort: verifyTunnel.localPort,
            credential: minted,
          });
        } finally {
          await verifyTunnel.close();
        }
      },
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    });
    credential = outcome.credential;
    releaseId = outcome.releaseId;
    provisionedEnvironmentId = outcome.environmentId;
  }

  // The long-lived session. This is the ONLY thing that publishes to the proxy,
  // and it verifies the handshake through the tunnel it just opened before it
  // does — so the id below is one the running server actually claimed.
  const session = await (input.openSession ?? openRemoteEnvironmentSession)({
    config: input.config,
    environmentId: provisionedEnvironmentId as EnvironmentId,
    credential,
    serverVersion: artifacts.serverVersion,
    remotePort: port,
    ...(input.controlDirectory === undefined ? {} : { controlDirectory: input.controlDirectory }),
    ...(input.onLost === undefined ? {} : { onLost: input.onLost }),
  });

  return {
    environmentId: session.environmentId,
    session,
    releaseId,
    close: () => session.close(),
  };
}

/**
 * A tunnel used only to run the bootstrap's own handshake, then closed.
 *
 * Separate from the session's tunnel because it exists BEFORE we are willing to
 * publish anything: it proves the freshly started server answers, and if it
 * does not, the bootstrapper rolls back and no long-lived forward was ever
 * held open for a server that failed verification.
 */
async function openVerificationTunnel(input: {
  readonly config: RemoteHostConfig;
  readonly remotePort: number;
  readonly controlDirectory?: string | undefined;
}) {
  const { openSshTunnel } = await import("./sshTunnel");
  return openSshTunnel({
    config: input.config,
    remotePort: input.remotePort,
    ...(input.controlDirectory === undefined ? {} : { controlDirectory: input.controlDirectory }),
  });
}
