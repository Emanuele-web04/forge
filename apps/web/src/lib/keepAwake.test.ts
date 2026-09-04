import { describe, expect, it } from "vitest";
import {
  KEEP_AWAKE_MODE_OPTIONS,
  keepAwakeIndicatorState,
  keepAwakeModeLabel,
  keepAwakeStatusLabel,
  keepAwakeTooltip,
} from "./keepAwake";

describe("keepAwake copy helpers", () => {
  it("exposes the three modes in On / Agent / Off order", () => {
    expect(KEEP_AWAKE_MODE_OPTIONS.map((option) => option.value)).toEqual([
      "always",
      "agent",
      "off",
    ]);
    expect(KEEP_AWAKE_MODE_OPTIONS.map((option) => option.label)).toEqual(["On", "Agent", "Off"]);
    for (const option of KEEP_AWAKE_MODE_OPTIONS) {
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  it("formats status and tooltip", () => {
    expect(keepAwakeModeLabel("agent")).toBe("Agent");
    expect(keepAwakeStatusLabel({ mode: "always", active: true })).toBe("On · Active");
    expect(keepAwakeStatusLabel({ mode: "agent", active: false })).toBe("Agent · Idle");
    expect(keepAwakeTooltip({ mode: "always", active: true, error: null })).toBe(
      "Keep awake: On · Active",
    );
    expect(keepAwakeTooltip({ mode: "always", active: false, error: "caffeinate exited" })).toBe(
      "Keep awake: caffeinate exited",
    );
  });
});

describe("keepAwakeIndicatorState", () => {
  it("is dimmed when off", () => {
    expect(keepAwakeIndicatorState("off", false, null)).toBe("dimmed");
  });

  it("is default when armed but idle", () => {
    expect(keepAwakeIndicatorState("agent", false, null)).toBe("default");
    expect(keepAwakeIndicatorState("always", false, null)).toBe("default");
  });

  it("is highlighted while caffeinate runs", () => {
    expect(keepAwakeIndicatorState("agent", true, null)).toBe("highlighted");
    expect(keepAwakeIndicatorState("always", true, null)).toBe("highlighted");
  });

  it("is error whenever an error is present, regardless of mode", () => {
    expect(keepAwakeIndicatorState("always", false, "boom")).toBe("error");
    expect(keepAwakeIndicatorState("off", false, "boom")).toBe("error");
  });
});
