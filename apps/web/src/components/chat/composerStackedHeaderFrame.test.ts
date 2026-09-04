// FILE: composerStackedHeaderFrame.test.ts
// Purpose: Pins the shared composer-stacked activity rail token used by ComposerStackedHeaderFrame.
// Layer: Chat composer regression test
// Depends on: composerPickerStyles sizing token.

import { describe, expect, it } from "vitest";

import { COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME } from "./composerPickerStyles";

describe("COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME", () => {
  it("sits at an inset, centered w-14/15 rail above the composer input", () => {
    const classes = COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME.split(/\s+/);

    expect(classes).toContain("-mb-px");
    expect(classes).toContain("w-14/15");
    expect(classes).toContain("min-w-0");
    // The narrower rail must stay centered so it reads as an inset above the
    // full-width composer input rather than hugging one edge.
    expect(classes).toContain("mx-auto");
  });
});
