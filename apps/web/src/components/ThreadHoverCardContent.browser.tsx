// FILE: ThreadHoverCardContent.browser.tsx
// Purpose: Characterizes the shared thread hover card: orchestrator line for
//          subagents, model + effort, and the status label carrying its tone.
// Layer: Browser UI test

import "../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { ThreadStatusPill } from "./Sidebar.logic";
import { ThreadHoverCardContent } from "./ThreadHoverCardContent";

const WORKING: ThreadStatusPill = {
  label: "Working",
  colorClass: "text-sky-600 dark:text-sky-300/80",
  dotClass: "bg-sky-500 dark:bg-sky-300/80",
  pulse: true,
};

const COMPLETED: ThreadStatusPill = {
  label: "Completed",
  colorClass: "text-emerald-600 dark:text-emerald-300/90",
  dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
  pulse: false,
};

function renderCard(overrides: Partial<Parameters<typeof ThreadHoverCardContent>[0]> = {}) {
  return render(
    <ThreadHoverCardContent
      title="Review compact subagents diff"
      timeLabel="4m"
      projectName="synara"
      projectCwd={null}
      sourceProjectName={null}
      branch="feature/compact-sidebar-subagents"
      worktreeName={null}
      model={{
        provider: "claudeAgent",
        modelLabel: "Claude Fable 5.1",
        statusLabel: "High",
        fastMode: false,
      }}
      status={null}
      {...overrides}
    />,
  );
}

describe("ThreadHoverCardContent", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("names the orchestrator for a subagent and keeps model + effort", async () => {
    const screen = await renderCard({ parentTitle: "Implementar compact sidebar subagents" });

    await expect
      .element(screen.getByText("Subagent of · Implementar compact sidebar subagents"))
      .toBeVisible();
    await expect.element(screen.getByText("Claude Fable 5.1")).toBeVisible();
    await expect.element(screen.getByText("High")).toBeVisible();
    await expect.element(screen.getByText("feature/compact-sidebar-subagents")).toBeVisible();
  });

  it("omits the orchestrator line for root threads", async () => {
    const screen = await renderCard({ parentTitle: null });

    await expect.element(screen.getByText("Review compact subagents diff")).toBeVisible();
    expect(document.body.textContent).not.toContain("Subagent of");
  });

  it("shows the status label in the status pill's own tone", async () => {
    const working = await renderCard({ status: WORKING });
    const workingLabel = working.getByText("Working").element();
    expect(workingLabel.closest('[class*="text-sky-"]')).not.toBeNull();
    await working.unmount();

    const completed = await renderCard({ status: COMPLETED });
    const completedLabel = completed.getByText("Completed").element();
    expect(completedLabel.closest('[class*="text-emerald-"]')).not.toBeNull();
  });
});
