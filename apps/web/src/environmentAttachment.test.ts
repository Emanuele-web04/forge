// FILE: environmentAttachment.test.ts
// Purpose: Pins the one detail four per-environment subscribers kept getting
//          wrong — a REPLACED client must be re-attached, not skipped.
// Layer: Web transport aggregation tests

import { EnvironmentId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { createEnvironmentAttachmentRegistry } from "./environmentAttachment";
import type { WsEnvironmentClient } from "./wsNativeApi";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");

function client(environmentId: EnvironmentId): WsEnvironmentClient {
  // A fresh object each call: identity is the whole point of these tests.
  return { environmentId } as unknown as WsEnvironmentClient;
}

describe("environment attachment registry", () => {
  it("attaches each environment once", () => {
    const attach = vi.fn(() => vi.fn());
    const registry = createEnvironmentAttachmentRegistry({ attach });
    const local = client(LOCAL_ENVIRONMENT_ID);

    registry.sync([local]);
    registry.sync([local]);
    registry.sync([local]);

    expect(attach).toHaveBeenCalledTimes(1);
    expect(registry.attachedCount).toBe(1);
  });

  it("RE-ATTACHES when a new client appears under the same environment id", () => {
    // The defect this exists to prevent. A logout disposes a transport without
    // deregistering, so the registry hands back a new client object under the
    // same id. Keying on the id alone treats it as already-attached and leaves
    // the detach pointing at a dead client whose registries were cleared — that
    // environment silently stops updating, with nothing thrown anywhere.
    const detachFirst = vi.fn();
    const detachSecond = vi.fn();
    const attach = vi.fn().mockReturnValueOnce(detachFirst).mockReturnValueOnce(detachSecond);
    const registry = createEnvironmentAttachmentRegistry({ attach });

    registry.sync([client(REMOTE_ENVIRONMENT_ID)]);
    registry.sync([client(REMOTE_ENVIRONMENT_ID)]);

    expect(attach).toHaveBeenCalledTimes(2);
    expect(detachFirst).toHaveBeenCalledTimes(1);
    expect(detachSecond).not.toHaveBeenCalled();
    expect(registry.attachedCount).toBe(1);
  });

  it("detaches and releases an environment that has gone away", () => {
    const detach = vi.fn();
    const release = vi.fn();
    const registry = createEnvironmentAttachmentRegistry({ attach: () => detach, release });
    const local = client(LOCAL_ENVIRONMENT_ID);

    registry.sync([local, client(REMOTE_ENVIRONMENT_ID)]);
    registry.sync([local]);

    expect(detach).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(REMOTE_ENVIRONMENT_ID);
  });

  it("does NOT release on a mere replacement", () => {
    // `release` drops cached state that must not outlive the connection. A
    // replacement is still the same environment, and releasing there would
    // throw away a descriptor or provider statuses that are about to be
    // re-reported anyway — a visible flicker for no reason.
    const release = vi.fn();
    const registry = createEnvironmentAttachmentRegistry({ attach: () => vi.fn(), release });

    registry.sync([client(REMOTE_ENVIRONMENT_ID)]);
    registry.sync([client(REMOTE_ENVIRONMENT_ID)]);

    expect(release).not.toHaveBeenCalled();
  });

  it("honours skip so a subscriber can exclude an environment", () => {
    const attach = vi.fn(() => vi.fn());
    const registry = createEnvironmentAttachmentRegistry({
      attach,
      skip: (candidate) => candidate.environmentId === LOCAL_ENVIRONMENT_ID,
    });

    registry.sync([client(LOCAL_ENVIRONMENT_ID), client(REMOTE_ENVIRONMENT_ID)]);

    expect(attach).toHaveBeenCalledTimes(1);
    expect(registry.attachedCount).toBe(1);
  });

  it("dispose detaches and releases everything, and later syncs are inert", () => {
    const detach = vi.fn();
    const release = vi.fn();
    const attach = vi.fn(() => detach);
    const registry = createEnvironmentAttachmentRegistry({ attach, release });

    registry.sync([client(LOCAL_ENVIRONMENT_ID), client(REMOTE_ENVIRONMENT_ID)]);
    registry.dispose();

    expect(detach).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(registry.attachedCount).toBe(0);

    // A registry change can still fire after teardown; re-attaching then would
    // leak a subscription nothing will ever release.
    registry.sync([client(LOCAL_ENVIRONMENT_ID)]);
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("survives a detach that throws without stranding the entry", () => {
    const registry = createEnvironmentAttachmentRegistry({
      attach: () => () => {
        throw new Error("detach failed");
      },
    });
    registry.sync([client(REMOTE_ENVIRONMENT_ID)]);

    expect(() => registry.sync([])).toThrow("detach failed");
    // Deleted before detaching, so the failed entry is gone rather than left
    // looking live to the next sync.
    expect(registry.attachedCount).toBe(0);
  });
});
