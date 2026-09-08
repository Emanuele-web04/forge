import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ComputerAvailability, ComputerSetupRequiredPayload } from "./computer";

function decodes(input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(ComputerAvailability as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("ComputerAvailability permission-required", () => {
  const PERMISSION_REQUIRED = {
    kind: "permission-required",
    missing: ["accessibility", "screenRecording"],
    message: "Synara needs Accessibility and Screen Recording to control this Mac.",
    buildSignature: "adhoc",
  } as const;

  it("round-trips the grants, the message and the build signature", () => {
    const decoded = Schema.decodeUnknownSync(ComputerAvailability)(PERMISSION_REQUIRED);
    expect(decoded).toEqual(PERMISSION_REQUIRED);
    expect(Schema.encodeUnknownSync(ComputerAvailability)(decoded)).toEqual(PERMISSION_REQUIRED);
  });

  it("keeps the other availability kinds decodable", () => {
    expect(decodes({ kind: "available", backend: "mac" })).toBe(true);
    expect(decodes({ kind: "unsupported-platform", platform: "linux" })).toBe(true);
    expect(decodes({ kind: "backend-unavailable", message: "No helper." })).toBe(true);
  });

  it("refuses a permission state that names no grant", () => {
    // An empty list would render as "Computer control needs " on the card, and
    // would mean the backend reported a permission problem it cannot name — a
    // state the setup signal expresses by not producing this kind at all.
    expect(decodes({ ...PERMISSION_REQUIRED, missing: [] })).toBe(false);
  });

  it("refuses an unknown grant name and an unknown signature", () => {
    expect(decodes({ ...PERMISSION_REQUIRED, missing: ["inputMonitoring"] })).toBe(false);
    expect(decodes({ ...PERMISSION_REQUIRED, buildSignature: "notarized" })).toBe(false);
  });
});

describe("ComputerSetupRequiredPayload", () => {
  it("round-trips the tool, the grants, the build signature and the responsible app", () => {
    const payload = {
      toolName: "computer_list_windows",
      missing: ["accessibility"],
      buildSignature: "adhoc",
      bundleId: "com.emanueledipietro.synara.dev",
    } as const;
    const decoded = Schema.decodeUnknownSync(ComputerSetupRequiredPayload)(payload);
    expect(decoded).toEqual(payload);
    expect(Schema.encodeUnknownSync(ComputerSetupRequiredPayload)(decoded)).toEqual(payload);
  });

  it("accepts a payload with no signature, and refuses an unknown one", () => {
    // Backends with no permission model report none, and the card simply says
    // nothing about stale grants — but "notarized" is a value nothing produces,
    // and reading it as ad-hoc would put a Terminal command in front of a
    // release user.
    const decodes = (input: unknown): boolean => {
      try {
        Schema.decodeUnknownSync(ComputerSetupRequiredPayload as never)(input);
        return true;
      } catch {
        return false;
      }
    };
    expect(decodes({ toolName: "computer_click", missing: [] })).toBe(true);
    expect(decodes({ toolName: "computer_click", missing: [], buildSignature: "notarized" })).toBe(
      false,
    );
    expect(decodes({ toolName: "computer_click", missing: ["inputMonitoring"] })).toBe(false);
  });
});
