import { SynaraCreateThreadsInput } from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { fingerprintGatewayCreateThreadsInput } from "./creationUtils.ts";

const decodeCreateInput = Schema.decodeUnknownSync(SynaraCreateThreadsInput);

describe("fingerprintGatewayCreateThreadsInput", () => {
  it("preserves the legacy default-profile fingerprint without erasing explicit profiles", () => {
    const legacyInput = {
      requestId: "legacy-profile-retry",
      threads: [
        {
          prompt: "Do the work",
          target: {
            provider: "codex",
            model: "gpt-5.5",
            options: { reasoningEffort: "high" },
          },
        },
      ],
    } as const;
    const explicitDefaultInput = {
      ...legacyInput,
      threads: [
        {
          ...legacyInput.threads[0],
          target: { ...legacyInput.threads[0].target, profileId: "default" },
        },
      ],
    } as const;
    const workInput = {
      ...legacyInput,
      threads: [
        {
          ...legacyInput.threads[0],
          target: { ...legacyInput.threads[0].target, profileId: "work" },
        },
      ],
    } as const;

    const legacyFingerprint = fingerprintGatewayCreateThreadsInput(decodeCreateInput(legacyInput));
    expect(legacyFingerprint).toBe(
      "dd350426be22577bedac4d86f8c2b49af3b562c0898844f1063abfd8e6098a06",
    );
    expect(fingerprintGatewayCreateThreadsInput(decodeCreateInput(explicitDefaultInput))).toBe(
      legacyFingerprint,
    );
    expect(fingerprintGatewayCreateThreadsInput(decodeCreateInput(workInput))).not.toBe(
      legacyFingerprint,
    );
  });
});
