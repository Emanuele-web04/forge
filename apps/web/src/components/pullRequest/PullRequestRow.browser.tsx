// FILE: PullRequestRow.browser.tsx
// Purpose: Browser-level regression coverage for the separate row-select and pin controls.
// Layer: Pull request presentation test

import "../../index.css";

import type { PullRequestListEntry } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { PullRequestAvatar } from "./PullRequestAvatar";
import { PullRequestList } from "./PullRequestList";
import { PullRequestProjectFilterPopover } from "./PullRequestListFilters";
import { PullRequestRow } from "./PullRequestRow";
import { groupPullRequestEntriesByInvolvement } from "./pullRequestList.logic";
import { focusPullRequestRow, isFocusInsideRightDock } from "./pullRequestFocus";

function makeEntry(isPinned: boolean): PullRequestListEntry {
  return {
    projectId: "project-1" as PullRequestListEntry["projectId"],
    projectTitle: "Project One",
    repository: "acme/widgets",
    number: 42,
    title: "Prioritize this pull request",
    url: "https://github.com/acme/widgets/pull/42",
    author: null,
    headBranch: "feature/pin",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 2,
    deletions: 1,
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
    reviewDecision: null,
    viewerReviewRequested: false,
    isPinned,
    projectContexts: [
      {
        projectId: "project-1" as PullRequestListEntry["projectId"],
        projectTitle: "Project One",
        isPinned,
      },
    ],
    mergeability: "unknown",
    labels: [],
  };
}

function StatefulGroupedList() {
  const [entry, setEntry] = useState(() => makeEntry(false));
  return (
    <PullRequestList
      entries={[entry]}
      grouped={groupPullRequestEntriesByInvolvement([entry], null)}
      selectedProjectId={undefined}
      selectedRepo={undefined}
      selectedNumber={undefined}
      onSelect={() => {}}
      onTogglePinned={(current) => setEntry({ ...current, isPinned: !current.isPinned })}
    />
  );
}

function FocusRestoreHarness() {
  const entry = makeEntry(false);
  const [dockOpen, setDockOpen] = useState(true);
  const closeDock = () => {
    const shouldRestore = isFocusInsideRightDock(document.activeElement);
    setDockOpen(false);
    if (shouldRestore) {
      requestAnimationFrame(() => focusPullRequestRow(document, entry));
    }
  };
  return (
    <>
      <PullRequestRow entry={entry} selected onClick={() => {}} onTogglePinned={() => {}} />
      {dockOpen ? (
        <div data-right-dock-content>
          <button type="button" onClick={closeDock}>
            Close panel
          </button>
        </div>
      ) : null}
    </>
  );
}

describe("PullRequestRow pin control", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("pins without also selecting the pull request", async () => {
    const onSelect = vi.fn();
    const onTogglePinned = vi.fn();
    await render(
      <PullRequestRow
        entry={makeEntry(false)}
        selected={false}
        onClick={onSelect}
        onTogglePinned={onTogglePinned}
      />,
    );

    await page.getByRole("button", { name: "Pin pull request #42" }).click();

    expect(onTogglePinned).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Pin pull request #42");
    expect(page.getByRole("img", { name: "PR open" })).toBeVisible();
    expect(
      document
        .querySelector('button[aria-label="Pin pull request #42"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("exposes the selected row as the current list item without changing pin semantics", async () => {
    await render(
      <PullRequestRow
        entry={makeEntry(false)}
        selected
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    expect(document.querySelector('button[aria-current="true"]')).not.toBeNull();
    expect(
      document
        .querySelector('button[aria-label="Pin pull request #42"]')
        ?.hasAttribute("aria-current"),
    ).toBe(false);
  });

  it("exposes the persisted pinned state as a dedicated sibling button", async () => {
    await render(
      <PullRequestRow
        entry={makeEntry(true)}
        selected={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    const pinButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Unpin pull request #42"]',
    );
    expect(pinButton?.getAttribute("aria-pressed")).toBe("true");
    expect(pinButton?.querySelector("button")).toBeNull();
    expect(pinButton?.parentElement?.closest("button")).toBeNull();
  });

  it("keeps pin focus when the row moves into the Pinned group", async () => {
    await render(<StatefulGroupedList />);
    const originalButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Pin pull request #42"]',
    );

    await page.getByRole("button", { name: "Pin pull request #42" }).click();

    const movedButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Unpin pull request #42"]',
    );
    expect(document.body.textContent).toContain("Pinned");
    expect(movedButton).toBe(originalButton);
    expect(document.activeElement).toBe(originalButton);
  });

  it("shows project identity in all-project rows and their pin labels", async () => {
    await render(
      <PullRequestRow
        entry={makeEntry(false)}
        selected={false}
        showProjectTitle
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    expect(page.getByText("Project One")).toBeVisible();
    expect(page.getByRole("button", { name: "Pin pull request #42 in Project One" })).toBeVisible();
  });

  it("summarizes shared repository rows without implying one owning project", async () => {
    const entry = makeEntry(false);
    await render(
      <PullRequestRow
        entry={{
          ...entry,
          projectContexts: [
            ...(entry.projectContexts ?? []),
            {
              projectId: "project-2" as PullRequestListEntry["projectId"],
              projectTitle: "Project Two",
              isPinned: false,
            },
          ],
        }}
        selected={false}
        showProjectTitle
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    expect(page.getByText("2 projects")).toBeVisible();
    expect(page.getByRole("button", { name: "Pin pull request #42 in 2 projects" })).toBeVisible();
  });

  it("keeps scoped rows minimal", async () => {
    await render(
      <PullRequestRow
        entry={makeEntry(false)}
        selected={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    expect(document.body.textContent).not.toContain("Project One");
    expect(page.getByRole("button", { name: "Pin pull request #42" })).toBeVisible();
  });

  it("renders neutral diff statistics when colors are disabled", async () => {
    await render(
      <PullRequestRow
        entry={makeEntry(false)}
        selected={false}
        showDiffColors={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    expect(page.getByText("+2", { exact: true }).element().className).not.toContain(
      "color-decoration-added",
    );
    expect(page.getByText("-1", { exact: true }).element().className).not.toContain(
      "color-decoration-deleted",
    );
  });

  it("restores focus by remote identity when aggregate project context changes", async () => {
    const entry = makeEntry(false);
    await render(
      <PullRequestRow entry={entry} selected={false} onClick={vi.fn()} onTogglePinned={vi.fn()} />,
    );

    expect(
      focusPullRequestRow(document, {
        ...entry,
        projectId: "different-project" as PullRequestListEntry["projectId"],
      }),
    ).toBe(true);
    expect(document.activeElement?.getAttribute("data-pull-request-number")).toBe("42");
  });

  it("returns focus to the selected row when the focused dock closes", async () => {
    await render(<FocusRestoreHarness />);

    await page.getByRole("button", { name: "Close panel" }).click();

    await vi.waitFor(() => {
      expect(document.activeElement?.hasAttribute("data-pull-request-row")).toBe(true);
    });
    expect(document.activeElement?.getAttribute("data-project-id")).toBe("project-1");
    expect(document.activeElement?.getAttribute("data-pull-request-number")).toBe("42");
  });
});

describe("PullRequestProjectFilterPopover", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("announces the selected project on both the trigger and options", async () => {
    const projectId = "project-1" as PullRequestListEntry["projectId"];
    await render(
      <PullRequestProjectFilterPopover
        projects={[[projectId, "Project One"]]}
        value={projectId}
        onChange={vi.fn()}
      />,
    );

    const trigger = page.getByRole("button", {
      name: "Filter pull requests by project: Project One",
    });
    expect(trigger).toBeVisible();
    expect(
      document
        .querySelector('button[aria-label="Filter pull requests by project: Project One"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    await trigger.click();
    const optionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
    const selectedOption = optionButtons.find(
      (button) => button.textContent?.trim() === "Project One",
    );
    const allProjectsOption = optionButtons.find(
      (button) => button.textContent?.trim() === "All projects",
    );
    expect(selectedOption?.getAttribute("aria-pressed")).toBe("true");
    expect(allProjectsOption?.getAttribute("aria-pressed")).toBe("false");
    // Close the portalled popover before the browser renderer unmounts this test root.
    await page.getByRole("button", { name: "All projects" }).click();
  });
});

describe("PullRequestAvatar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not derive an image URL from a team slug", async () => {
    await render(
      <PullRequestAvatar
        actor={{ login: "platform-team", name: null, avatarUrl: null, url: null }}
      />,
    );

    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("P");
  });
});
