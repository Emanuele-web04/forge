// FILE: automationForm.test.ts
// Purpose: Locks down the inline schedule-field validators — the structural cron check and
// the IANA timezone check that gate commit-on-blur edits on the automation detail page.
// Layer: Web lib test

import { describe, expect, it } from "vitest";

import { automationCronExpressionError, automationTimezoneError } from "./automationForm";

describe("automationCronExpressionError", () => {
  it("accepts structurally valid 5-field expressions", () => {
    expect(automationCronExpressionError("* * * * *")).toBeNull();
    expect(automationCronExpressionError("*/15 9-17 * * 1-5")).toBeNull();
    expect(automationCronExpressionError("0 0 1,15 * *")).toBeNull();
    expect(automationCronExpressionError("  30 4 * * 0  ")).toBeNull();
  });

  it("rejects the wrong field count", () => {
    expect(automationCronExpressionError("")).not.toBeNull();
    expect(automationCronExpressionError("* * * *")).not.toBeNull();
    expect(automationCronExpressionError("* * * * * *")).not.toBeNull();
  });

  it("rejects fields with characters outside the cron vocabulary", () => {
    expect(automationCronExpressionError("every 5 min * *")).not.toBeNull();
    expect(automationCronExpressionError("0 0 * * MON")).not.toBeNull();
  });

  // Range semantics (minute 0-59, month 1-12, …) are deliberately left to the server's
  // parser — the client check is structural only, so in-range enforcement lives in one place.
  it("does not enforce value ranges", () => {
    expect(automationCronExpressionError("99 99 99 99 99")).toBeNull();
  });
});

describe("automationTimezoneError", () => {
  it("accepts real IANA zones", () => {
    expect(automationTimezoneError("Europe/Rome")).toBeNull();
    expect(automationTimezoneError("UTC")).toBeNull();
    expect(automationTimezoneError("  America/New_York  ")).toBeNull();
  });

  it("rejects an empty value — committing it would unrender the row for good", () => {
    expect(automationTimezoneError("")).toBe("Add a timezone");
    expect(automationTimezoneError("   ")).toBe("Add a timezone");
  });

  it("rejects unknown zones", () => {
    expect(automationTimezoneError("Europe/Atlantis")).toBe("Unknown timezone");
    expect(automationTimezoneError("not a zone")).toBe("Unknown timezone");
  });
});
