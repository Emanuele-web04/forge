// FILE: SidebarSurfacePicker.test.tsx
// Purpose: Guards the visible branding shown by the sidebar surface picker.
// Layer: Component rendering test
// Depends on: SidebarSurfacePicker and React server rendering.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SidebarSurfacePicker } from "./Sidebar";

vi.mock("./terminal/terminalRuntimeRegistry", () => ({
  terminalRuntimeRegistry: {
    disposeTerminal: vi.fn(),
  },
}));

vi.mock("~/branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/branding")>()),
  APP_BASE_NAME: "Test App",
}));

describe("SidebarSurfacePicker", () => {
  it("derives the threads surface title from the shared application name", () => {
    const markup = renderToStaticMarkup(
      <SidebarSurfacePicker
        views={["threads", "studio"]}
        activeView="threads"
        onSelectView={vi.fn()}
      />,
    );

    expect(markup).toContain("Test App by nacholk");
  });
});
