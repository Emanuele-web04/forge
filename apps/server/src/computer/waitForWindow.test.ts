import { describe, expect, it } from "vitest";
import type { ComputerWindow } from "@synara/contracts";
import { waitForWindow } from "./waitForWindow.ts";

const window: ComputerWindow = {
  id: "7",
  title: "Draft",
  appName: "Helium",
  focused: false,
  minimized: false,
  visible: true,
};

describe("launch window readiness", () => {
  it("returns an existing matching app window immediately", async () => {
    expect(await waitForWindow(async () => [window], "/Applications/Helium.app", 2_000)).toBe(
      window,
    );
  });
  it("observes again when launch has not produced a window yet", async () => {
    let reads = 0;
    expect(await waitForWindow(async () => (++reads === 1 ? [] : [window]), "Helium", 500)).toBe(
      window,
    );
    expect(reads).toBe(2);
  });
  it("does not choose between multiple app windows or unrelated apps", async () => {
    expect(
      await waitForWindow(async () => [window, { ...window, id: "8" }], "Helium", 0),
    ).toBeNull();
    expect(await waitForWindow(async () => [window], "Other", 0)).toBeNull();
  });
  it("stops without another observation when cancelled", async () => {
    const controller = new AbortController();
    let reads = 0;
    await expect(
      waitForWindow(
        async () => {
          reads += 1;
          controller.abort();
          return [];
        },
        "Helium",
        500,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(reads).toBe(1);
  });
});
