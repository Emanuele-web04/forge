import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ServerLifecycleEvents, ServerLifecycleEventsLive } from "./serverLifecycleEvents";

const runWithLifecycle = <A, E>(effect: Effect.Effect<A, E, ServerLifecycleEvents>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ServerLifecycleEventsLive)));

describe("ServerLifecycleEvents", () => {
  it("publishes sequenced events and keeps the latest event per type", async () => {
    const snapshot = await runWithLifecycle(
      Effect.gen(function* () {
        const lifecycle = yield* ServerLifecycleEvents;
        yield* lifecycle.publish({
          type: "welcome",
          payload: {
            cwd: "/one",
            homeDir: "/home/tester",
            chatWorkspaceRoot: "/home/tester/.synara/chats",
            studioWorkspaceRoot: "/home/tester/.synara/chats/Studio",
            projectName: "one",
          },
        });
        yield* lifecycle.publish({
          type: "ready",
          payload: {
            at: "2026-01-01T00:00:00.000Z",
          },
        });
        yield* lifecycle.publish({
          type: "welcome",
          payload: {
            cwd: "/two",
            homeDir: "/home/tester",
            chatWorkspaceRoot: "/home/tester/.synara/chats",
            studioWorkspaceRoot: "/home/tester/.synara/chats/Studio",
            projectName: "two",
          },
        });
        return yield* lifecycle.snapshot;
      }),
    );

    expect(snapshot.sequence).toBe(3);
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events.map((event) => event.type)).toEqual(["welcome", "ready"]);
    expect(snapshot.events.find((event) => event.type === "welcome")?.payload).toMatchObject({
      cwd: "/two",
      projectName: "two",
    });
  });
});
