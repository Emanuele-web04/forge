import { describe, expect, it } from "vitest";

import {
  computerPermissionSetupMessage,
  computerPermissionsBlockControl,
  computerStaleGrantAdvice,
  listComputerPermissions,
  sortComputerPermissions,
} from "./computerPermissions";

describe("computer permission copy", () => {
  it("names grants in one fixed order whatever order they arrive in", () => {
    // Two surfaces describing the same state as "Screen Recording and
    // Accessibility" and "Accessibility and Screen Recording" is how this got
    // centralised in the first place.
    expect(sortComputerPermissions(["screenRecording", "accessibility"])).toEqual([
      "accessibility",
      "screenRecording",
    ]);
    expect(listComputerPermissions(["screenRecording", "accessibility"])).toBe(
      "Accessibility and Screen Recording",
    );
    expect(listComputerPermissions(["screenRecording"])).toBe("Screen Recording");
    expect(listComputerPermissions([])).toBe("");
  });

  it("explains a stale grant on an ad-hoc build, naming the right tccutil service", () => {
    const advice = computerStaleGrantAdvice(
      ["accessibility", "screenRecording"],
      "adhoc",
      "com.emanueledipietro.synara.dev",
    );
    // The server clears the stale row itself before it asks, so the user's part
    // is a dialog; the command survives only for the case where none appears.
    expect(advice).toContain("allow the dialog when it appears");
    expect(advice).toContain("If none appears");
    expect(advice).toContain("tccutil reset Accessibility com.emanueledipietro.synara.dev");
    // `ScreenCapture`, not "Screen Recording": the label is not the service name,
    // and a user who types the label gets an error instead of a reset.
    expect(advice).toContain("tccutil reset ScreenCapture com.emanueledipietro.synara.dev");
  });

  it("names the responsible app rather than assuming the released one", () => {
    // A `.dev` flavor resetting the production identifier would revoke a
    // separately installed Synara's grants and fix nothing here.
    const advice = computerStaleGrantAdvice(
      ["accessibility"],
      "adhoc",
      "com.example.synara.canary",
    );
    expect(advice).toContain("tccutil reset Accessibility com.example.synara.canary");
    expect(advice).not.toContain("com.emanueledipietro.synara");
  });

  it("withholds the tccutil sentence when no responsible bundle id is known", () => {
    // Better to say nothing than to hand the user a command that resets some
    // other Synara. The dialog half of the advice still stands on its own.
    for (const bundleId of [undefined, "", "   "]) {
      const advice = computerStaleGrantAdvice(["accessibility"], "adhoc", bundleId);
      expect(advice).toContain("allow the dialog when it appears");
      expect(advice).not.toContain("tccutil");
      expect(advice).not.toContain("If none appears");
    }
    expect(computerPermissionSetupMessage(["accessibility"], "adhoc")).not.toContain("tccutil");
  });

  it("says nothing about stale grants on a signed build", () => {
    expect(computerStaleGrantAdvice(["accessibility"], "signed", "com.example.app")).toBeNull();
    const message = computerPermissionSetupMessage(["accessibility"], "signed", "com.example.app");
    expect(message).toContain("Accessibility");
    expect(message).toContain("System Settings");
    expect(message).not.toContain("tccutil");
  });

  it("puts the stale-grant explanation into the ad-hoc setup message", () => {
    const message = computerPermissionSetupMessage(
      ["accessibility"],
      "adhoc",
      "com.emanueledipietro.synara",
    );
    expect(message).toContain("System Settings");
    expect(message).toContain("tccutil reset Accessibility com.emanueledipietro.synara");
  });
});

describe("computerPermissionsBlockControl", () => {
  it("separates the grant that stops everything from the one that only blinds", () => {
    // The whole point of the split: a missing Screen Recording grant leaves the
    // window list, the accessibility tree and every input working, and telling
    // an agent to stop over it costs the user the task.
    expect(computerPermissionsBlockControl(["accessibility"])).toBe(true);
    expect(computerPermissionsBlockControl(["accessibility", "screenRecording"])).toBe(true);
    expect(computerPermissionsBlockControl(["screenRecording"])).toBe(false);
    expect(computerPermissionsBlockControl([])).toBe(false);
  });
});
