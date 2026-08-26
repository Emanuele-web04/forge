// FILE: central-icons.test.tsx
// Purpose: Pin the CentralIcon mask-failure fallback — a failed icon asset must
//          resolve to the inline fallback glyph instead of painting nothing
//          (Chromium fully masks out elements whose mask-image fails to load).
// Layer: Web lib unit tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CentralIcon,
  FALLBACK_CENTRAL_ICON_MASK,
  centralIconMaskValue,
  resolveCentralIconMask,
} from "./central-icons";

describe("centralIconMaskValue", () => {
  it("builds a centered contain mask from the icon asset URL", () => {
    expect(centralIconMaskValue("/central-icons-reversed/sidebar-simple-left-wide.svg")).toBe(
      'url("/central-icons-reversed/sidebar-simple-left-wide.svg") center / contain no-repeat',
    );
  });
});

describe("resolveCentralIconMask", () => {
  it("uses the real asset while it loads successfully", () => {
    expect(resolveCentralIconMask("/icons/x.svg", false)).toBe(
      'url("/icons/x.svg") center / contain no-repeat',
    );
  });

  it("falls back to the inline data-URI glyph when the asset fails", () => {
    const mask = resolveCentralIconMask("/icons/missing.svg", true);
    expect(mask).toBe(FALLBACK_CENTRAL_ICON_MASK);
    expect(mask).toContain("data:image/svg+xml");
    expect(mask.endsWith("center / contain no-repeat")).toBe(true);
  });
});

describe("CentralIcon", () => {
  it("renders the asset mask and no fallback marker on the initial paint", () => {
    const html = renderToStaticMarkup(<CentralIcon name="sidebar-simple-left-wide" />);
    expect(html).toContain('data-slot="central-icon"');
    expect(html).toContain("/central-icons-reversed/sidebar-simple-left-wide.svg");
    expect(html).not.toContain("data-icon-fallback");
  });

  it("returns nothing for an invalid icon name", () => {
    expect(renderToStaticMarkup(<CentralIcon name={"../escape"} />)).toBe("");
  });
});
