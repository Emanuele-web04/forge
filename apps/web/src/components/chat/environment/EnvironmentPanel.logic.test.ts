import { describe, expect, it } from "vitest";

import { shouldShowStudioFolderRow } from "./EnvironmentPanel.logic";

describe("shouldShowStudioFolderRow", () => {
  it("shows a picked Studio reference folder only when the native shell can open it", () => {
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: true,
        studioFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: true,
        studioFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: false,
      }),
    ).toBe(false);
  });

  it("hides the row outside Studio and when no folder was picked", () => {
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: false,
        studioFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: true,
        studioFolderPath: null,
        nativeShellAvailable: true,
      }),
    ).toBe(false);
  });
});
