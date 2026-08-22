import { describe, expect, it } from "vitest";

import { calculateBreadcrumbLayout } from "./workspaceFilePreviewBreadcrumb";

describe("calculateBreadcrumbLayout", () => {
  it("keeps directories that fit beside the rendered filename", () => {
    expect(
      calculateBreadcrumbLayout({
        containerWidth: 160,
        renderedFileWidth: 40,
        prefixWidths: [60, 60],
        ellipsisWidth: 20,
        trailingReserveWidth: 0,
      }),
    ).toBeNull();
  });

  it("uses space from a hidden ellipsis for a narrow trailing directory", () => {
    expect(
      calculateBreadcrumbLayout({
        containerWidth: 50,
        renderedFileWidth: 30,
        prefixWidths: [100, 18],
        ellipsisWidth: 24,
        trailingReserveWidth: 0,
      }),
    ).toEqual({ visibleTail: 1, showEllipsis: false });
  });

  it("keeps the nearest directories that fit after the ellipsis", () => {
    expect(
      calculateBreadcrumbLayout({
        containerWidth: 150,
        renderedFileWidth: 50,
        prefixWidths: [60, 45, 30],
        ellipsisWidth: 20,
        trailingReserveWidth: 0,
      }),
    ).toEqual({ visibleTail: 2, showEllipsis: true });
  });
});
