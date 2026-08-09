// FILE: MessagesTimeline.worktreeSetup.browser.tsx
// Purpose: Browser regression for the transient worktree-setup step card lifecycle.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId } from "@synara/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { deriveTimelineEntries } from "../../session-logic";
import type {
  WorktreeSetupResolutionAction,
  WorktreeSetupSnapshot,
  WorktreeSetupStepStatus,
} from "../../types";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

function userEntry(id: string, text: string): TimelineEntries[number] {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role: "user",
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming: false,
    },
  };
}

function setupSnapshot(statuses: [WorktreeSetupStepStatus, WorktreeSetupStepStatus]) {
  return {
    steps: [
      { id: "create-branch", label: "Creating branch", status: statuses[0] },
      { id: "prepare-thread", label: "Linking thread workspace", status: statuses[1] },
    ],
  } satisfies WorktreeSetupSnapshot;
}

function setupActionSnapshot() {
  return {
    steps: [
      { id: "create-branch", label: "Creating branch", status: "done" },
      { id: "create-worktree", label: "Creating worktree", status: "done" },
      { id: "prepare-thread", label: "Linking thread workspace", status: "done" },
      { id: "run-setup-action", label: "Running setup action: Setup", status: "active" },
      { id: "start-session", label: "Starting session", status: "pending" },
    ],
  } satisfies WorktreeSetupSnapshot;
}

function WorktreeSetupTimeline() {
  const [worktreeSetup, setWorktreeSetup] = useState<WorktreeSetupSnapshot | null>(() =>
    setupSnapshot(["active", "pending"]),
  );

  return (
    <div>
      <button
        type="button"
        data-testid="advance-step"
        onClick={() => setWorktreeSetup(setupSnapshot(["done", "active"]))}
      >
        Advance step
      </button>
      <button type="button" data-testid="clear-setup" onClick={() => setWorktreeSetup(null)}>
        Clear setup
      </button>
      <div style={{ height: 420 }}>
        <MessagesTimeline
          hasMessages
          isWorking
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          worktreeSetup={worktreeSetup}
          timelineEntries={[userEntry("user-message", "Start in a worktree.")]}
          turnDiffSummaryByAssistantMessageId={new Map()}
          nowIso="2026-03-17T19:12:30.000Z"
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>
    </div>
  );
}

function SetupActionTimeline() {
  return (
    <div style={{ height: 420 }}>
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        worktreeSetup={setupActionSnapshot()}
        timelineEntries={[userEntry("user-message", "Start in a worktree.")]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

function FailedSetupWithoutMessagesTimeline() {
  return (
    <div style={{ height: 420 }}>
      <MessagesTimeline
        hasMessages={false}
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        worktreeSetup={setupSnapshot(["error", "pending"])}
        timelineEntries={[]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

function startingSessionSnapshot() {
  return {
    steps: [
      { id: "create-branch", label: "Creating branch", status: "done" },
      { id: "create-worktree", label: "Creating worktree", status: "done" },
      { id: "prepare-thread", label: "Linking thread workspace", status: "done" },
      { id: "start-session", label: "Starting session", status: "active" },
    ],
  } satisfies WorktreeSetupSnapshot;
}

function ResolvableSetupTimeline({
  snapshot,
  pendingAction,
  onResolve,
}: {
  snapshot: WorktreeSetupSnapshot;
  pendingAction?: WorktreeSetupResolutionAction | null;
  onResolve: (action: WorktreeSetupResolutionAction) => void;
}) {
  return (
    <div style={{ height: 420 }}>
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        worktreeSetup={snapshot}
        worktreeSetupPendingAction={pendingAction ?? null}
        onResolveWorktreeSetup={onResolve}
        timelineEntries={[userEntry("user-message", "Start in a worktree.")]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

const setupRow = () =>
  document.querySelector<HTMLElement>('[data-timeline-row-kind="worktree-setup"]');
const workingRow = () => document.querySelector<HTMLElement>('[data-timeline-row-kind="working"]');

describe("MessagesTimeline worktree setup card", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows step progress, then animates out and hands off to the working shimmer", async () => {
    const screen = await render(<WorktreeSetupTimeline />);

    try {
      await expect.poll(() => setupRow() !== null).toBe(true);
      expect(setupRow()?.textContent).toContain("Preparing worktree...");
      expect(setupRow()?.textContent).toContain("Creating branch");
      expect(setupRow()?.querySelector(".shimmer")?.classList).not.toContain("shimmer-once");
      // The generic working shimmer stays suppressed while the card is open.
      expect(workingRow()).toBeNull();

      document.querySelector<HTMLButtonElement>('[data-testid="advance-step"]')?.click();
      await expect.poll(() => setupRow()?.textContent).toContain("Linking thread workspace");
      expect(workingRow()).toBeNull();

      document.querySelector<HTMLButtonElement>('[data-testid="clear-setup"]')?.click();
      // The card stays mounted through the disclosure close animation while the
      // working shimmer takes over immediately.
      expect(setupRow()).not.toBeNull();
      await expect.poll(() => workingRow() !== null).toBe(true);
      await expect.poll(() => setupRow() === null, { timeout: 2000 }).toBe(true);
      expect(workingRow()).not.toBeNull();
      expect(workingRow()?.querySelector(".shimmer")?.classList).not.toContain("shimmer-once");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a failed first-send setup row visible after the optimistic message is removed", async () => {
    const screen = await render(<FailedSetupWithoutMessagesTimeline />);

    try {
      await expect.poll(() => setupRow()?.textContent).toContain("Creating branch");
      expect(setupRow()?.textContent).toContain("failed");
      expect(document.body.textContent).not.toContain("Send a message to start the conversation.");
    } finally {
      await screen.unmount();
    }
  });

  it("offers Cancel and Work locally while preparation can still be resolved", async () => {
    const resolved: WorktreeSetupResolutionAction[] = [];
    const screen = await render(
      <ResolvableSetupTimeline
        snapshot={setupSnapshot(["active", "pending"])}
        onResolve={(action) => resolved.push(action)}
      />,
    );

    try {
      await expect.poll(() => setupRow() !== null).toBe(true);
      const buttons = Array.from(setupRow()?.querySelectorAll("button") ?? []);
      const workLocally = buttons.find((button) => button.textContent === "Work locally");
      const cancel = buttons.find((button) => button.textContent === "Cancel");
      expect(workLocally).toBeDefined();
      expect(cancel).toBeDefined();

      workLocally?.click();
      cancel?.click();
      expect(resolved).toEqual(["work-locally", "cancel"]);
    } finally {
      await screen.unmount();
    }
  });

  it("disables the actions and relabels the chosen one while it applies", async () => {
    const screen = await render(
      <ResolvableSetupTimeline
        snapshot={setupSnapshot(["active", "pending"])}
        pendingAction="cancel"
        onResolve={() => {}}
      />,
    );

    try {
      await expect.poll(() => setupRow()?.textContent).toContain("Cancelling...");
      const buttons = Array.from(setupRow()?.querySelectorAll("button") ?? []);
      expect(buttons.length).toBe(2);
      for (const button of buttons) {
        expect(button.disabled).toBe(true);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("hides the actions once the session is starting", async () => {
    const screen = await render(
      <ResolvableSetupTimeline snapshot={startingSessionSnapshot()} onResolve={() => {}} />,
    );

    try {
      await expect.poll(() => setupRow() !== null).toBe(true);
      expect(setupRow()?.textContent).not.toContain("Work locally");
      expect(setupRow()?.textContent).not.toContain("Cancel");
    } finally {
      await screen.unmount();
    }
  });

  it("hides the actions after the setup has failed", async () => {
    const screen = await render(
      <ResolvableSetupTimeline
        snapshot={setupSnapshot(["error", "pending"])}
        onResolve={() => {}}
      />,
    );

    try {
      await expect.poll(() => setupRow()?.textContent).toContain("failed");
      expect(setupRow()?.textContent).not.toContain("Work locally");
      expect(setupRow()?.textContent).not.toContain("Cancel");
    } finally {
      await screen.unmount();
    }
  });

  it("renders the project setup action as its own active worktree step", async () => {
    const screen = await render(<SetupActionTimeline />);

    try {
      await expect.poll(() => setupRow()?.textContent).toContain("Running setup action: Setup");
      expect(setupRow()?.textContent).toContain("Starting session");
      expect(workingRow()).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
