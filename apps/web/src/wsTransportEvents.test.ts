// FILE: wsTransportEvents.test.ts
// Purpose: Locks down per-environment transport-state replay used for projection reconciliation.
// Layer: Web transport utility unit tests

import { EnvironmentId, WsCompatibilityError } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import {
  addWsBuildSkewListener,
  addWsCompatibilityIssueListener,
  addWsTransportStateListener,
  emitWsBuildSkew,
  emitWsCompatibilityIssue,
  emitWsTransportState,
  readLatestWsBuildSkew,
  readLatestWsCompatibilityIssue,
  resetWsTransportEventsForTests,
} from "./wsTransportEvents";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("remote-environment");

const compatibilityIssue = new WsCompatibilityError({
  message: "Update this client.",
  code: "WS_PROTOCOL_INCOMPATIBLE",
  retryable: false,
  action: "update-client",
  serverBuild: "0.5.2",
  protocolEpoch: 1,
  minRevision: 1,
  maxRevision: 1,
});

/** Live fanout runs through DOM CustomEvents, which this runner has no window for. */
function stubWindow(): void {
  const target = new EventTarget();
  vi.stubGlobal("window", {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
}

describe("WebSocket transport state events", () => {
  afterEach(() => {
    resetWsTransportEventsForTests();
    vi.unstubAllGlobals();
  });

  it("replays an already-open transport to a late reconciliation listener", () => {
    emitWsTransportState("open");
    const listener = vi.fn();

    const unsubscribe = addWsTransportStateListener(listener, { replayCurrent: true });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("open");
    unsubscribe();
  });

  it("defaults to the local environment on both emit and subscribe", () => {
    emitWsTransportState("open");
    const listener = vi.fn();

    const unsubscribe = addWsTransportStateListener(listener, {
      environmentId: LOCAL_ENVIRONMENT_ID,
      replayCurrent: true,
    });

    expect(listener).toHaveBeenCalledWith("open");
    unsubscribe();
  });

  it("does not deliver one environment's state to another's listener", () => {
    stubWindow();
    const localListener = vi.fn();
    const remoteListener = vi.fn();
    const unsubscribeLocal = addWsTransportStateListener(localListener);
    const unsubscribeRemote = addWsTransportStateListener(remoteListener, {
      environmentId: REMOTE_ENVIRONMENT_ID,
    });

    emitWsTransportState("closed", { environmentId: REMOTE_ENVIRONMENT_ID });

    expect(remoteListener).toHaveBeenCalledWith("closed");
    expect(localListener).not.toHaveBeenCalled();

    unsubscribeLocal();
    unsubscribeRemote();
  });

  it("replays only the subscribed environment's latest state", () => {
    emitWsTransportState("open");
    emitWsTransportState("closed", { environmentId: REMOTE_ENVIRONMENT_ID });

    const localListener = vi.fn();
    const remoteListener = vi.fn();
    const unsubscribeLocal = addWsTransportStateListener(localListener, { replayCurrent: true });
    const unsubscribeRemote = addWsTransportStateListener(remoteListener, {
      environmentId: REMOTE_ENVIRONMENT_ID,
      replayCurrent: true,
    });

    expect(localListener).toHaveBeenCalledExactlyOnceWith("open");
    expect(remoteListener).toHaveBeenCalledExactlyOnceWith("closed");

    unsubscribeLocal();
    unsubscribeRemote();
  });

  /**
   * The skew channel's sibling filters (transport state, compatibility issue)
   * are both covered; this one was not, and it is the one attached to a
   * user-facing claim. `TransportBuildSkewNotice` reads LOCAL_ENVIRONMENT_ID
   * only, so an unfiltered event would show "Read-only: this client and server
   * run mismatched builds" — naming the LOCAL build pair — because a different
   * server is on another version, and local writes would then be refused. A
   * read-only banner that is not true is worse than no banner.
   */
  it("scopes build skew to its environment", () => {
    stubWindow();
    const localListener = vi.fn();
    const unsubscribe = addWsBuildSkewListener(LOCAL_ENVIRONMENT_ID, localListener);

    emitWsBuildSkew(REMOTE_ENVIRONMENT_ID, {
      clientBuild: "0.6.0",
      serverBuild: "0.5.2",
    });

    expect(localListener).not.toHaveBeenCalled();
    expect(readLatestWsBuildSkew(LOCAL_ENVIRONMENT_ID)).toBeNull();
    expect(readLatestWsBuildSkew(REMOTE_ENVIRONMENT_ID)).toEqual({
      clientBuild: "0.6.0",
      serverBuild: "0.5.2",
    });

    unsubscribe();
  });

  it("delivers build skew to the environment that owns it", () => {
    stubWindow();
    const localListener = vi.fn();
    const unsubscribe = addWsBuildSkewListener(LOCAL_ENVIRONMENT_ID, localListener);

    emitWsBuildSkew(LOCAL_ENVIRONMENT_ID, { clientBuild: "0.6.0", serverBuild: "0.5.2" });

    expect(localListener).toHaveBeenCalledWith({ clientBuild: "0.6.0", serverBuild: "0.5.2" });

    unsubscribe();
  });

  it("scopes compatibility issues to their environment", () => {
    stubWindow();
    const localListener = vi.fn();
    const unsubscribe = addWsCompatibilityIssueListener(localListener);

    emitWsCompatibilityIssue(compatibilityIssue, { environmentId: REMOTE_ENVIRONMENT_ID });

    expect(localListener).not.toHaveBeenCalled();
    expect(readLatestWsCompatibilityIssue()).toBeNull();
    expect(readLatestWsCompatibilityIssue({ environmentId: REMOTE_ENVIRONMENT_ID })).toBe(
      compatibilityIssue,
    );

    unsubscribe();
  });
});
