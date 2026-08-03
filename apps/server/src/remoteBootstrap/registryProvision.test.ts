import { describe, expect, it } from "vitest";

import { createFakeRemoteHost } from "./fakeRemoteHost";
import { remoteInstallLayout } from "./remoteInstallLayout";
import { provisionFromRegistry } from "./registryProvision";
import { RegistryInstallRefusedError } from "./registryInstall";

const layout = remoteInstallLayout("/home/deploy/.synara/remote");
const ENVIRONMENT_ID = "6f9d0c6e-7a1f-4d2b-9a3c-0e5d1b2c3d4e";

function provision(overrides: Record<string, unknown> = {}) {
  const host = createFakeRemoteHost();
  return {
    host,
    run: () =>
      provisionFromRegistry({
        connection: host.connection,
        layout,
        packageName: "@synara/cli",
        version: "0.6.5",
        environmentId: ENVIRONMENT_ID,
        port: 45123,
        ...overrides,
      }),
  };
}

describe("provisionFromRegistry", () => {
  it("writes the credential and environment id before the server starts", async () => {
    const { host, run } = provision();
    const outcome = await run();

    // The server reads both at boot. Minting the credential after start would
    // leave a window where a running server accepts a token nobody holds.
    expect(host.readFile(layout.credentialFile)?.trim()).toBe(outcome.credential.token);
    expect(host.readFile(layout.environmentIdFile)?.trim()).toBe(ENVIRONMENT_ID);
  });

  it("never puts the credential in argv", async () => {
    // argv is readable in the remote process table by every other local user.
    const { host, run } = provision();
    const outcome = await run();
    for (const argv of host.commands) {
      for (const token of argv) {
        expect(token).not.toContain(outcome.credential.token);
      }
    }
  });

  it("reports the pinned version as the release id", async () => {
    const { run } = provision();
    expect((await run()).releaseId).toBe("0.6.5");
  });

  it("refuses a floating version rather than installing whatever is newest", async () => {
    // The pin is what lets the handshake verify the build and an upgrade roll
    // back. Enforced here too, not only at the spec helper.
    const { run } = provision({ version: "latest" });
    await expect(run()).rejects.toThrow(RegistryInstallRefusedError);
  });

  it("keeps the state directory private", async () => {
    const { host, run } = provision();
    await run();
    // No `--`: BSD/macOS chmod rejects it, and the paths are absolute.
    expect(host.commands).toContainEqual(["chmod", "700", layout.root, layout.stateDirectory]);
  });

  it("never reaches the network from the remote for anything but the registry", async () => {
    // The registry install is the ONE network call this design makes on the
    // remote. A stray curl/wget would be a second, unaudited one.
    const { host, run } = provision();
    await run();
    for (const argv of host.commands) {
      const line = argv.join(" ");
      for (const forbidden of ["curl", "wget", "git clone", "pip"]) {
        expect(line).not.toContain(forbidden);
      }
    }
  });
});
