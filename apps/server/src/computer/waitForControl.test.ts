import { describe, expect, it, vi } from "vitest";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { waitForControl } from "./waitForControl.ts";

const target = { windowId: "fake-calculator", label: "Display" };

describe("waiting for a control", () => {
  it("returns immediately for an existing control without waiting the timeout", async () => {
    const backend = new FakeComputerBackend();
    const read = vi.fn(() => backend.getState({ includeTree: true }));
    expect(await waitForControl(read, target, 10_000)).toMatchObject({ status: "ready" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(backend.callsFor("click")).toHaveLength(0);
  });

  it("polls until a delayed control appears", async () => {
    const state = await new FakeComputerBackend().getState({ includeTree: true });
    const read = vi.fn()
      .mockResolvedValueOnce({ ...state, root: { ...state.root!, children: [] } })
      .mockResolvedValue(state);
    expect(await waitForControl(read, target, 1_000)).toMatchObject({ status: "ready" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops at timeout and never invents readiness", async () => {
    const backend = new FakeComputerBackend();
    expect(await waitForControl(() => backend.getState({}), { ...target, label: "Missing" }, 0))
      .toMatchObject({ status: "timeout" });
  });

  it("does not poll unavailable windows or incomplete trees", async () => {
    const state = await new FakeComputerBackend().getState({ includeTree: true });
    for (const unavailable of [
      { ...state, accessibility: { status: "partial" as const, unavailableWindowIds: [target.windowId] } },
      { ...state, root: { ...state.root!, children: [], truncated: true } },
    ]) {
      const read = vi.fn().mockResolvedValue(unavailable);
      expect(await waitForControl(read, target, 10_000)).toMatchObject({ status: "unavailable" });
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it("does not wait for a closed window", async () => {
    const state = await new FakeComputerBackend().getState({});
    const read = vi.fn().mockResolvedValue({ ...state, windows: [] });
    expect(await waitForControl(read, target, 10_000)).toMatchObject({ status: "closed" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not claim a duplicate label is ready", async () => {
    const state = await new FakeComputerBackend().getState({ includeTree: true });
    const read = vi.fn().mockResolvedValue({
      ...state, root: { ...state.root!, children: [...state.root!.children, ...state.root!.children] },
    });
    expect(await waitForControl(read, target, 10_000)).toMatchObject({ status: "ambiguous" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("stops polling when its turn is cancelled", async () => {
    const controller = new AbortController();
    const state = await new FakeComputerBackend().getState({});
    const read = vi.fn(async () => { controller.abort(); return state; });
    await expect(waitForControl(read, target, 10_000, controller.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
