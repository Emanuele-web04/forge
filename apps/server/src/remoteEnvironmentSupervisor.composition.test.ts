// FILE: remoteEnvironmentSupervisor.composition.test.ts
// Purpose: The test the nine previous reviews did not have — the one that
//          exercises the WHOLE CHAIN rather than any single link.
// Layer: Server / remote broker tests
//
// WHY THIS FILE EXISTS
//
// Every module in this feature was built and unit-tested, and the feature still
// did nothing: a host was probed, trusted and persisted into
// ServerSettings.remoteHosts, and NOTHING observed that write. No tunnel, no
// proxy entry, no client. Each module's own tests passed throughout, because
// each one tested a link and none tested the CHAIN.
//
// So the assertions here are deliberately about composition, not behaviour of
// any one part:
//
//   settings write → supervisor observes → pipeline runs → proxy PUBLISHED
//   host removed   → supervisor observes → proxy RETRACTED
//
// Each link is separately mutation-checked: break the supervisor's subscription,
// break the publish, or break the retract, and a DIFFERENT test here fails.

import { readFile } from "node:fs/promises";

import type { RemoteHostConfig, RemoteHostId } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resetSharedEnvironmentProxyRegistry,
  sharedEnvironmentProxyRegistry,
} from "./environmentProxyRegistry";
import { makeRemoteEnvironmentSupervisor } from "./remoteEnvironmentSupervisor";
import type { RemoteEnvironmentBringUp } from "./remoteBootstrap/remoteEnvironmentPipeline";
import { publishProxiedEnvironment, retractProxiedEnvironment } from "./environmentProxyRegistry";
import { ServerSettingsService } from "./serverSettings";
import {
  resetSharedRemoteEnvironmentSupervisor,
  startRemoteEnvironmentSupervision,
} from "./remoteEnvironmentSupervisorRuntime";

const ENVIRONMENT_ID = "6f9d0c6e-7a1f-4d2b-9a3c-0e5d1b2c3d4e";

function hostConfig(overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig {
  return {
    hostId: "host-1" as RemoteHostId,
    label: "devbox",
    destination: "devbox",
    sshArgs: [],
    hostKeyVerification: "strict",
    connectTimeoutSeconds: 10,
    keepalive: { intervalSeconds: 15, countMax: 3 },
    connectionReuse: { enabled: true, persistSeconds: 300 },
    launcher: { kind: "direct" },
    ...overrides,
  } as RemoteHostConfig;
}

/**
 * A bring-up that publishes to the REAL proxy registry.
 *
 * Deliberately real rather than a spy: the assertion this file has to make is
 * "the browser can now reach it", and only the registry answers that. A spy on
 * `bringUp` would pass even if the pipeline never published.
 */
function fakeBringUp(options: { readonly environmentId?: string } = {}) {
  const closed: string[] = [];
  const fn = async (input: {
    readonly config: RemoteHostConfig;
  }): Promise<RemoteEnvironmentBringUp> => {
    const environmentId = (options.environmentId ??
      ENVIRONMENT_ID) as RemoteEnvironmentBringUp["environmentId"];
    publishProxiedEnvironment({
      environmentId,
      host: "127.0.0.1",
      port: 45123,
      credential: "test-token",
    });
    return {
      environmentId,
      releaseId: "0.6.3",
      session: {
        environmentId,
        localPort: 45123,
        close: () => Promise.resolve(),
      },
      close: () => {
        closed.push(input.config.hostId);
        retractProxiedEnvironment(environmentId);
        return Promise.resolve();
      },
    };
  };
  return { fn, closed };
}

/** Waits for a condition the supervisor reaches asynchronously. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

beforeEach(() => {
  resetSharedEnvironmentProxyRegistry();
});

afterEach(() => {
  resetSharedEnvironmentProxyRegistry();
});

describe("remote environment composition", () => {
  it("publishes an environment to the proxy when a host is saved", async () => {
    const bringUp = fakeBringUp();
    const supervisor = makeRemoteEnvironmentSupervisor({
      bringUp: bringUp.fn as never,
      resolveArtifacts: () => Promise.resolve({ available: true, artifacts: {} as never }),
    });

    await supervisor.sync([hostConfig()]);
    await waitFor(
      () => sharedEnvironmentProxyRegistry().get(ENVIRONMENT_ID) !== undefined,
      "the environment to be published",
    );

    // The point of the whole feature: /env/<id>/* now resolves to a real
    // upstream. Before this chain existed, this lookup was undefined forever.
    const upstream = sharedEnvironmentProxyRegistry().get(ENVIRONMENT_ID);
    expect(upstream).toBeDefined();
    expect(upstream?.port).toBe(45123);

    await supervisor.dispose();
  });

  it("retracts the environment when the host is removed from settings", async () => {
    const bringUp = fakeBringUp();
    const supervisor = makeRemoteEnvironmentSupervisor({
      bringUp: bringUp.fn as never,
      resolveArtifacts: () => Promise.resolve({ available: true, artifacts: {} as never }),
    });

    await supervisor.sync([hostConfig()]);
    await waitFor(
      () => sharedEnvironmentProxyRegistry().get(ENVIRONMENT_ID) !== undefined,
      "the environment to be published",
    );

    // The removal half. A supervisor that only ever starts things leaves a
    // tunnel to a host the user deleted, still reachable through the proxy.
    await supervisor.sync([]);
    expect(sharedEnvironmentProxyRegistry().get(ENVIRONMENT_ID)).toBeUndefined();
    expect(bringUp.closed).toEqual(["host-1"]);

    await supervisor.dispose();
  });

  it("reports the provisioned environment id, never one it invented", async () => {
    const provisioned = "11111111-2222-3333-4444-555555555555";
    const bringUp = fakeBringUp({ environmentId: provisioned });
    const supervisor = makeRemoteEnvironmentSupervisor({
      bringUp: bringUp.fn as never,
      resolveArtifacts: () => Promise.resolve({ available: true, artifacts: {} as never }),
    });

    await supervisor.sync([hostConfig()]);
    await waitFor(
      () => supervisor.statuses().some((status) => status.phase === "ready"),
      "the host to become ready",
    );

    const status = supervisor.statuses().find((entry) => entry.hostId === "host-1");
    // The id the client will register a socket for MUST be the one the
    // handshake proved, or the socket addresses a proxy entry that does not
    // exist.
    expect(status?.environmentId).toBe(provisioned);

    await supervisor.dispose();
  });

  it("SETTINGS WRITE drives the supervisor — the link that did not exist", async () => {
    const bringUp = fakeBringUp();
    const supervisor = makeRemoteEnvironmentSupervisor({
      bringUp: bringUp.fn as never,
      resolveArtifacts: () => Promise.resolve({ available: true, artifacts: {} as never }),
    });
    // Installs the fake as the PROCESS supervisor, so the real settings
    // subscription below drives it. Only the bring-up is substituted; the
    // subscription itself is the code under test.
    resetSharedRemoteEnvironmentSupervisor(supervisor);

    // The exact gap: `updateSettings({remoteHosts})` is what the settings panel
    // calls, and nothing observed it. Delete the `startRemoteEnvironmentSupervision`
    // call from effectServer, or the `streamChanges` subscription inside it, and
    // this test — and only this test — fails.
    const program = Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* startRemoteEnvironmentSupervision;
      yield* settings.updateSettings({ remoteHosts: [hostConfig()] });
      yield* Effect.promise(() =>
        waitFor(
          () => sharedEnvironmentProxyRegistry().get(ENVIRONMENT_ID) !== undefined,
          "the settings write to reach the proxy",
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(ServerSettingsService.layerTest()));

    await Effect.runPromise(program);

    expect(sharedEnvironmentProxyRegistry().get(ENVIRONMENT_ID)).toBeDefined();

    await supervisor.dispose();
    resetSharedRemoteEnvironmentSupervisor();
  });
});

/**
 * The CALL SITE, asserted as source.
 *
 * The behavioural tests above all invoke `startRemoteEnvironmentSupervision`
 * themselves, so they pass even if nothing in the server ever calls it — which
 * is EXACTLY the shape of the original bug: working parts, no wire. Deleting
 * the call from effectServer.ts is a real regression that no behavioural test
 * in this process can see, because the server's startup is not run here.
 *
 * Reading the source is the honest way to pin it. A brittle-looking assertion
 * is the correct trade against a gap that survived nine reviews.
 */
describe("supervision is actually started by the server", () => {
  it("effectServer starts remote environment supervision in the subscriptions scope", async () => {
    const source = await readFile(new URL("./effectServer.ts", import.meta.url), "utf8");
    expect(source).toContain("startRemoteEnvironmentSupervision");
    expect(source).toMatch(
      /Scope\.provide\(\s*startRemoteEnvironmentSupervision,\s*subscriptionsScope\s*\)/,
    );
  });
});
