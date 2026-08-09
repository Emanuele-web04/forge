import { describe, expect, it } from "vitest";

import {
  composerOverlayBottomClearancePx,
  composerOverlayScrollMaskImage,
} from "./composerOverlay";

describe("composer overlay mask", () => {
  it("does not mask a transcript without a composer inset", () => {
    expect(composerOverlayScrollMaskImage(0)).toBeNull();
  });

  it("expands the transparent footer cut to the measured footer height", () => {
    expect(composerOverlayBottomClearancePx(200, 128)).toBe(72);
    // Opaque until 40px above the footer cut (112px), not the overlay top (120px):
    // the glass surface obscures the editor region, the mask only clears the footer.
    expect(composerOverlayScrollMaskImage(100, 72)).toBe(
      "linear-gradient(to bottom, #000 calc(100% - 112px), transparent calc(100% - 72px))",
    );
  });

  it("keeps the default clearance for a single-line footer", () => {
    expect(composerOverlayBottomClearancePx(200, 170)).toBe(52);
  });

  it("clamps an oversized footer cut to the overlay instead of inverting the gradient", () => {
    expect(composerOverlayScrollMaskImage(40, 100)).toBe(
      "linear-gradient(to bottom, #000 calc(100% - 60px), transparent calc(100% - 60px))",
    );
  });
});
