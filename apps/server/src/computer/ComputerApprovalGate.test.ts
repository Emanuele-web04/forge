import { describe, expect, it } from "vitest";
import { ComputerApprovalGate } from "./ComputerApprovalGate.ts";

describe("ComputerApprovalGate", () => {
  it.each(["accept", "decline", "cancel", "acceptForSession"] as const)(
    "binds %s to the requesting conversation and one call",
    async (decision) => {
      const gate = new ComputerApprovalGate();
      const signal = new AbortController().signal;
      let requestId = "";
      const events: unknown[] = [];
      const result = gate.request({
        threadId: "a",
        signal,
        publish: async (id, resolved) => {
          events.push(resolved ?? "opened");
          requestId = id;
          if (resolved === undefined) {
            expect(gate.respond("b", id, "accept")).toBe(false);
            expect(gate.respond("a", id, decision)).toBe(true);
          }
        },
      });
      expect(await result).toBe(decision === "accept");
      expect(gate.respond("a", requestId, "accept")).toBe(false);
      expect(events).toEqual(["opened", decision === "acceptForSession" ? "decline" : decision]);
    },
  );

  it("cancels a pending prompt and rejects late decisions", async () => {
    const gate = new ComputerApprovalGate();
    const controller = new AbortController();
    let requestId = "";
    const resolved: unknown[] = [];
    const result = gate.request({
      threadId: "a",
      signal: controller.signal,
      publish: async (id, decision) => {
        requestId = id;
        resolved.push(decision);
        if (decision === undefined) controller.abort();
      },
    });
    await expect(result).rejects.toThrow();
    expect(resolved).toEqual([undefined, "cancel"]);
    expect(gate.respond("a", requestId, "accept")).toBe(false);
  });
});
