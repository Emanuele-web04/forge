import { describe, expect, it } from "vitest";

import type { WorkLogLiveActivity } from "../workLog";
import {
  formatLiveActivityMeta,
  formatLiveActivityElapsed,
  formatLiveActivityPrimary,
  formatLiveActivityProgress,
  formatLiveActivityStateLabel,
  friendlyLiveCommandTarget,
  liveActivityElapsedMs,
} from "./liveActivityPresentation";

const STARTED_AT = "2026-07-26T14:00:00.000Z";

function runningActivity(
  overrides: Partial<WorkLogLiveActivity> = {},
): WorkLogLiveActivity {
  return {
    state: "running_tool",
    label: "Bash",
    startedAt: STARTED_AT,
    lastActivityAt: "2026-07-26T14:02:11.000Z",
    elapsedSeconds: 131,
    ...overrides,
  };
}

describe("live activity presentation", () => {
  it("uses a friendly PowerShell name instead of leaking the full wrapper command", () => {
    const command =
      '"C:\\Users\\Example\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command "powershell -NoProfile -Command \\"1..8\\""';

    expect(friendlyLiveCommandTarget(command)).toBe("PowerShell");
    expect(
      formatLiveActivityPrimary({
        activity: runningActivity(),
        entry: { itemType: "command_execution" },
        heading: "Running command",
        rawCommand: command,
      }),
    ).toBe("Running command · PowerShell");
  });

  it("preserves the existing target for non-command activity", () => {
    expect(
      formatLiveActivityPrimary({
        activity: runningActivity({
          state: "completed",
          label: "Read",
        }),
        entry: { requestKind: "file-read" },
        heading: "Read",
        displayTarget: "Read app.ts",
      }),
    ).toBe("Completed file read · Read app.ts");
  });

  it("renders recent activity and elapsed time from one normalized state", () => {
    const activity = runningActivity();
    const nowMs = Date.parse("2026-07-26T14:02:14.000Z");

    expect(liveActivityElapsedMs(activity, nowMs)).toBe(134_000);
    expect(formatLiveActivityMeta(activity, nowMs)).toBe(
      "Active 3s ago · 2m 14s elapsed",
    );
  });

  it("reports quiet live tools without claiming they are frozen", () => {
    expect(
      formatLiveActivityMeta(
        runningActivity({
          lastActivityAt: "2026-07-26T14:01:44.000Z",
          elapsedSeconds: 104,
        }),
        Date.parse("2026-07-26T14:02:14.000Z"),
      ),
    ).toBe("No activity for 30s · 2m 14s elapsed");
  });

  it("keeps progress and terminal states provider-agnostic", () => {
    const completed = runningActivity({
      state: "completed",
      lastActivityAt: "2026-07-26T14:02:14.000Z",
      elapsedSeconds: 134,
      progress: 1,
    });

    expect(formatLiveActivityMeta(completed, Date.parse("2026-07-26T14:03:00.000Z"))).toBe(
      "Completed · 2m 14s elapsed · 100%",
    );
  });

  it("does not invent elapsed time when a terminal event has no known start", () => {
    const activity: WorkLogLiveActivity = {
      state: "completed",
      label: "Deploy",
      lastActivityAt: "2026-07-26T14:02:14.000Z",
    };

    expect(liveActivityElapsedMs(activity, Date.parse("2026-07-26T14:03:00.000Z"))).toBeNull();
    expect(formatLiveActivityMeta(activity, Date.parse("2026-07-26T14:03:00.000Z"))).toBe(
      "Completed",
    );
  });

  it("shares normalized state, elapsed, and progress labels across activity surfaces", () => {
    const activity = runningActivity({
      state: "running_tool",
      progress: 0.42,
    });

    expect(formatLiveActivityStateLabel(activity.state)).toBe("Running tool");
    expect(
      formatLiveActivityElapsed(activity, Date.parse("2026-07-26T14:02:14.000Z")),
    ).toBe("2m 14s");
    expect(formatLiveActivityProgress(activity.progress ?? 0)).toBe("42%");
  });
});
