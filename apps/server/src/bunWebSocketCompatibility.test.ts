import { describe, expect, it } from "vitest";

import { patchCloseEventTarget } from "./bunWebSocketCompatibility.ts";

type CloseEventLike = {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
};

class FakeCloseEventTarget {
  readonly listeners = new Set<(...args: ReadonlyArray<unknown>) => void>();

  addEventListener(_type: string, listener: unknown): void {
    if (typeof listener === "function") {
      this.listeners.add(listener as (...args: ReadonlyArray<unknown>) => void);
    }
  }

  removeEventListener(_type: string, listener: unknown): void {
    if (typeof listener === "function") {
      this.listeners.delete(listener as (...args: ReadonlyArray<unknown>) => void);
    }
  }

  emitClose(code: number, reason: string): void {
    for (const listener of this.listeners) {
      listener(code, reason);
    }
  }
}

class ObjectListener {
  readonly events: CloseEventLike[] = [];

  handleEvent(event: CloseEventLike): void {
    this.events.push(event);
  }
}

describe("Bun WebSocket close-event compatibility", () => {
  it("keeps listener objects with a shared prototype method distinct", () => {
    const target = new FakeCloseEventTarget();
    patchCloseEventTarget(target);
    const first = new ObjectListener();
    const second = new ObjectListener();

    target.addEventListener("close", first);
    target.addEventListener("close", second);
    target.emitClose(1000, "done");

    expect(first.events).toEqual([{ code: 1000, reason: "done", wasClean: true }]);
    expect(second.events).toEqual([{ code: 1000, reason: "done", wasClean: true }]);

    target.removeEventListener("close", second);
    target.emitClose(1001, "away");

    expect(first.events).toHaveLength(2);
    expect(second.events).toHaveLength(1);
  });
});
