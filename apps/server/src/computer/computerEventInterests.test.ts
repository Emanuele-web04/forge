import { Effect, Exit, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { ComputerEvent } from "@synara/contracts";

import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../managedAttachmentPrincipal.ts";
import { makeWsConnectionSessions } from "../wsConnectionSessions.ts";
import { ComputerEventInterests } from "./computerEventInterests.ts";

const stateEvent = (threadId: string) =>
  ({ type: "computer.thread-state", state: { threadId } }) as ComputerEvent;
const actionEvent = (threadId?: string) => ({ type: "computer.action", threadId }) as ComputerEvent;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function makeFixture() {
  const sessions = await Effect.runPromise(makeWsConnectionSessions);
  const cleanupRegistrations = { count: 0 };
  const interests = new ComputerEventInterests((key, cleanup) => {
    cleanupRegistrations.count += 1;
    return sessions.onClose(key, cleanup);
  });
  const listeners = new Set<(event: ComputerEvent) => void>();
  const onEvent = (listener: (event: ComputerEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    sessions,
    interests,
    cleanupRegistrations,
    listeners,
    onEvent,
    emit: (event: ComputerEvent) => {
      for (const listener of listeners) listener(event);
    },
    open: async () => {
      const scope = await Effect.runPromise(Scope.make());
      const key = await Effect.runPromise(
        Scope.provide(
          sessions.register({
            role: "owner",
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          }),
          scope,
        ),
      );
      const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
      cleanups.push(close);
      return { key, close };
    },
  };
}

describe("ComputerEventInterests", () => {
  it("filters thread state and actions while preserving global and human events", async () => {
    const f = await makeFixture();
    const first = await f.open();
    const second = await f.open();
    f.interests.watch(first.key, "thread-a");
    f.interests.watch(second.key, "thread-b");
    expect(f.interests.accepts(first.key, stateEvent("thread-a"))).toBe(true);
    expect(f.interests.accepts(first.key, actionEvent("thread-a"))).toBe(true);
    expect(f.interests.accepts(first.key, stateEvent("thread-b"))).toBe(false);
    expect(f.interests.accepts(second.key, actionEvent("thread-a"))).toBe(false);
    expect(f.interests.accepts(first.key, actionEvent())).toBe(true);
    expect(f.interests.accepts(first.key, { type: "computer.windows-changed", windows: [] })).toBe(
      true,
    );
  });

  it("retains live views beyond 256 connections and across disconnected-client churn", async () => {
    const f = await makeFixture();
    const first = await f.open();
    f.interests.watch(first.key, "first-view");
    const liveKeys: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const live = await f.open();
      liveKeys.push(live.key);
      f.interests.watch(live.key, `view-${index}`);
      const transient = await f.open();
      f.interests.watch(transient.key, "transient-view");
      await transient.close();
      expect(f.interests.accepts(transient.key, stateEvent("transient-view"))).toBe(false);
    }
    expect(f.interests.accepts(first.key, stateEvent("first-view"))).toBe(true);
    for (const [index, key] of liveKeys.entries()) {
      expect(f.interests.accepts(key, stateEvent(`view-${index}`))).toBe(true);
      expect(f.interests.accepts(key, stateEvent("first-view"))).toBe(false);
    }
  });

  it("falls back to broadcast beyond 64 distinct views without silently dropping any", async () => {
    const f = await makeFixture();
    const connection = await f.open();
    for (let index = 0; index < 100; index += 1) {
      f.interests.watch(connection.key, `view-${index}`);
    }
    for (let index = 0; index < 100; index += 1) {
      expect(f.interests.accepts(connection.key, stateEvent(`view-${index}`))).toBe(true);
    }
    expect(f.interests.accepts(connection.key, stateEvent("another-view"))).toBe(true);
    await connection.close();
    expect(f.interests.accepts(connection.key, stateEvent("view-0"))).toBe(false);
  });

  it("does not consume the distinct-view budget on repeated state reads", async () => {
    const f = await makeFixture();
    const connection = await f.open();
    for (let index = 0; index < 100; index += 1) f.interests.watch(connection.key, "same-view");
    expect(f.interests.accepts(connection.key, stateEvent("same-view"))).toBe(true);
    expect(f.interests.accepts(connection.key, stateEvent("another-view"))).toBe(false);
  });

  it("cleans state-only connections and rejects late reads after socket close", async () => {
    const f = await makeFixture();
    const connection = await f.open();
    f.interests.watch(connection.key, "view");
    await connection.close();
    f.interests.watch(connection.key, "view");
    expect(f.interests.accepts(connection.key, stateEvent("view"))).toBe(false);
    expect(f.sessions.onClose(connection.key, () => {})).toBe(false);
    expect(f.listeners.size).toBe(0);
  });

  it("keeps interests across stream retries but releases the old event listener", async () => {
    const f = await makeFixture();
    const connection = await f.open();
    const received: ComputerEvent[] = [];
    f.interests.watch(connection.key, "view");
    const stopFirst = f.interests.subscribe(connection.key, f.onEvent, (event) =>
      received.push(event),
    );
    f.emit(stateEvent("view"));
    stopFirst();
    expect(f.listeners.size).toBe(0);
    f.emit(stateEvent("view"));
    const stopSecond = f.interests.subscribe(connection.key, f.onEvent, (event) =>
      received.push(event),
    );
    f.emit(stateEvent("other"));
    f.emit(stateEvent("view"));
    expect(received).toEqual([stateEvent("view"), stateEvent("view")]);
    expect(f.cleanupRegistrations.count).toBe(1);
    await connection.close();
    f.emit(stateEvent("view"));
    expect(received).toHaveLength(2);
    stopSecond();
    expect(f.listeners.size).toBe(0);
  });

  it("preserves broadcast for callers without a connection context", async () => {
    const f = await makeFixture();
    const received: ComputerEvent[] = [];
    f.interests.watch(undefined, "view");
    const stop = f.interests.subscribe(undefined, f.onEvent, (event) => received.push(event));
    f.emit(stateEvent("other"));
    expect(received).toEqual([stateEvent("other")]);
    stop();
  });
});
