// FILE: SidebarBugReportButton.test.tsx
// Purpose: Verifies the sidebar bug-report button renders the correct
//          accessible label and tooltip trigger.
// Layer: Sidebar UI tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarBugReportButton } from "./SidebarBugReportButton";

function noop() {}

describe("SidebarBugReportButton", () => {
  it("renders an accessible, tooltip-enabled bug button", () => {
    const markup = renderToStaticMarkup(<SidebarBugReportButton onClick={noop} />);

    expect(markup).toContain('aria-label="Report a bug"');
    expect(markup).toContain('data-slot="tooltip-trigger"');
  });
});
