// FILE: registryProvision.ts
// Purpose: Put a pinned Synara server on a remote host by resolving it from a
//          package registry, and hand back the credential the handshake will
//          verify.
// Layer: Server / remote broker
// Exports: provisionFromRegistry, RegistryProvisionOutcome
//
// This is the registry-install peer of `bootstrapRemoteServer`. It occupies the
// same seam in the pipeline — put a server there, return a credential — so the
// half that follows (open a tunnel, verify the provisioning handshake, publish
// the proxy route) is unchanged and keeps its guarantees.
//
// What differs is only HOW the bytes arrive: npm resolves the dependency tree
// on the destination instead of an upload carrying node_modules for every OS
// and architecture. What does NOT differ is which version runs — the spec is
// pinned exactly by `registryPackageSpec`, and nothing is published until the
// handshake confirms that the process which answered reports that version and
// accepts this credential.

import { mintRemoteCredential, type RemoteCredential } from "./provisioningHandshake";
import { expectRemoteSuccess, type RemoteConnection } from "./remoteConnection";
import type { RemoteInstallLayout } from "./remoteInstallLayout";
import { registryPackageSpec, renderRegistryRunnerScript } from "./registryInstall";

export interface RegistryProvisionInput {
  readonly connection: RemoteConnection;
  readonly layout: RemoteInstallLayout;
  /** npm package name, e.g. `@synara/cli`. */
  readonly packageName: string;
  /** EXACT version. A tag or range is refused by `registryPackageSpec`. */
  readonly version: string;
  readonly environmentId: string;
  readonly port: number;
  readonly mintCredential?: () => RemoteCredential;
}

export interface RegistryProvisionOutcome {
  readonly environmentId: string;
  readonly releaseId: string;
  readonly credential: RemoteCredential;
  /** True when a healthy server was already running and was adopted. */
  readonly reused: boolean;
}

/**
 * Install (or adopt) the pinned server on the remote and return its credential.
 *
 * The credential is written to the host BEFORE the server starts, because the
 * server reads it at boot: minting it afterwards would leave a window where a
 * running server accepts a token nobody holds.
 */
export async function provisionFromRegistry(
  input: RegistryProvisionInput,
): Promise<RegistryProvisionOutcome> {
  const { connection, layout, environmentId, port } = input;
  const spec = registryPackageSpec(input.packageName, input.version);
  const credential = (input.mintCredential ?? mintRemoteCredential)();

  await expectRemoteSuccess(connection, ["mkdir", "-p", "--", layout.stateDirectory]);
  await expectRemoteSuccess(connection, ["chmod", "700", layout.root, layout.stateDirectory]);

  // Secrets travel on stdin, never in argv: argv is readable in the remote
  // process table by every other user on the host.
  for (const [path, contents] of [
    [layout.credentialFile, `${credential.token}\n`],
    [layout.environmentIdFile, `${environmentId}\n`],
  ] as const) {
    await expectRemoteSuccess(connection, ["sh", "-c", 'umask 077; cat > "$1"', "sh", path], {
      stdin: contents,
    });
  }

  const script = renderRegistryRunnerScript({
    packageSpec: spec,
    stateDirectory: layout.stateDirectory,
    port,
  });
  // The script goes on stdin too, so no part of it is ever an argv token and a
  // long script cannot overflow a command line.
  const started = await expectRemoteSuccess(connection, ["sh", "-s"], { stdin: script });

  return {
    environmentId,
    releaseId: input.version,
    credential,
    reused: started.stdout.startsWith("reused"),
  };
}
