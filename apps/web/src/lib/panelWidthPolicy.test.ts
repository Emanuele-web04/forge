// FILE: panelWidthPolicy.test.ts
// Purpose: Characterizes the half-width vs full-width side panel policy.
// Layer: Web panel layout utility tests

import { describe, expect, it } from "vitest";

import {
  acceptsFullWidthPanelDrag,
  resolveDockOpenWidth,
  resolveSplitPanelMaxWidth,
} from "./panelWidthPolicy";

describe("resolveDockOpenWidth", () => {
  it("opens to half the shell by default", () => {
    expect(resolveDockOpenWidth({ shellWidth: 1200, minWidth: 416, fullWidth: false })).toBe(600);
  });

  it("opens to the whole shell under full width", () => {
    expect(resolveDockOpenWidth({ shellWidth: 1200, minWidth: 416, fullWidth: true })).toBe(1200);
  });

  it("floors a fractional shell so the dock never overflows its row", () => {
    expect(resolveDockOpenWidth({ shellWidth: 1200.75, minWidth: 416, fullWidth: true })).toBe(
      1200,
    );
  });

  it("keeps the minimum width when half the shell is narrower", () => {
    expect(resolveDockOpenWidth({ shellWidth: 300, minWidth: 416, fullWidth: false })).toBe(416);
    expect(resolveDockOpenWidth({ shellWidth: 300, minWidth: 416, fullWidth: true })).toBe(416);
  });

  it("keeps a per-kind preferred width in both modes", () => {
    expect(
      resolveDockOpenWidth({
        shellWidth: 1200,
        minWidth: 416,
        preferredWidth: 520,
        fullWidth: true,
      }),
    ).toBe(520);
    expect(
      resolveDockOpenWidth({
        shellWidth: 1200,
        minWidth: 416,
        preferredWidth: 520,
        fullWidth: false,
      }),
    ).toBe(520);
  });

  it("returns null when the shell cannot be measured", () => {
    expect(resolveDockOpenWidth({ shellWidth: 0, minWidth: 416, fullWidth: true })).toBeNull();
    expect(
      resolveDockOpenWidth({ shellWidth: Number.NaN, minWidth: 416, fullWidth: false }),
    ).toBeNull();
  });
});

describe("acceptsFullWidthPanelDrag", () => {
  it("accepts a drag up to the shell edge", () => {
    expect(acceptsFullWidthPanelDrag({ nextWidth: 1200, shellWidth: 1200 })).toBe(true);
    expect(acceptsFullWidthPanelDrag({ nextWidth: 900, shellWidth: 1200 })).toBe(true);
  });

  it("rejects a drag past the shell edge", () => {
    expect(acceptsFullWidthPanelDrag({ nextWidth: 1201, shellWidth: 1200 })).toBe(false);
  });

  it("accepts the drag when the shell cannot be measured", () => {
    expect(acceptsFullWidthPanelDrag({ nextWidth: 1201, shellWidth: 0 })).toBe(true);
  });
});

describe("resolveSplitPanelMaxWidth", () => {
  it("reserves a readable chat column by default", () => {
    expect(
      resolveSplitPanelMaxWidth({
        paneWidth: 1000,
        minPanelWidth: 416,
        chatMinWidth: 320,
        fullWidth: false,
      }),
    ).toBe(680);
  });

  it("reserves nothing under full width", () => {
    expect(
      resolveSplitPanelMaxWidth({
        paneWidth: 1000,
        minPanelWidth: 416,
        chatMinWidth: 320,
        fullWidth: true,
      }),
    ).toBe(1000);
  });

  it("never resolves below the panel minimum", () => {
    expect(
      resolveSplitPanelMaxWidth({
        paneWidth: 400,
        minPanelWidth: 336,
        chatMinWidth: 320,
        fullWidth: false,
      }),
    ).toBe(336);
  });
});
