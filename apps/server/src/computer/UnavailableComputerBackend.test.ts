import { describe, expect, it } from "vitest";

import { ComputerBackendError, NO_COMPUTER_CAPABILITIES } from "./ComputerBackend.ts";
import { UnavailableComputerBackend } from "./UnavailableComputerBackend.ts";

const REASON = "No KWin compositor is answering on the session bus.";

describe("UnavailableComputerBackend", () => {
  it("reports the same sentence through availability, health, and every action", async () => {
    // An operator reading the availability card and an agent reading a tool
    // error must see one message, not two descriptions of the same fault.
    const backend = new UnavailableComputerBackend(REASON, { now: () => 1_700_000_000_000 });

    await expect(backend.availability()).resolves.toEqual({
      kind: "backend-unavailable",
      message: REASON,
    });
    expect(backend.health()).toEqual({
      status: "unavailable",
      consecutiveFailures: 1,
      reconnects: 0,
      lastFailure: { message: REASON, at: "2023-11-14T22:13:20.000Z" },
      captureAvailable: false,
    });
    await expect(backend.listWindows()).rejects.toThrow(REASON);
    await expect(backend.click()).rejects.toThrow(REASON);
  });

  it("refuses non-retryably: nothing about a backend that does not exist will change", async () => {
    const backend = new UnavailableComputerBackend(REASON);

    await expect(backend.getScreenSize()).rejects.toMatchObject({
      name: "ComputerBackendError",
      retryable: false,
    });
    await expect(backend.getScreenSize()).rejects.toBeInstanceOf(ComputerBackendError);
  });

  it("advertises no capabilities, so the panel offers nothing it cannot do", () => {
    expect(new UnavailableComputerBackend(REASON).capabilities()).toEqual(NO_COMPUTER_CAPABILITIES);
  });

  it("degrades an empty reason rather than emitting a message the contract rejects", async () => {
    const availability = await new UnavailableComputerBackend("   ").availability();

    expect(
      availability.kind === "backend-unavailable" && availability.message.length,
    ).toBeGreaterThan(0);
  });

  it("detaching and disposing are no-ops, so a failed boot still tears down cleanly", async () => {
    const backend = new UnavailableComputerBackend(REASON);
    const unsubscribe = backend.onEvent(() => undefined);

    expect(unsubscribe()).toBeUndefined();
    await expect(backend.detachStream()).resolves.toBeUndefined();
    expect(backend.dispose()).toBeUndefined();
  });
});
