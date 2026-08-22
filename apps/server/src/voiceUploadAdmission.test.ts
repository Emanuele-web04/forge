// FILE: voiceUploadAdmission.test.ts
// Purpose: Verifies bounded, leak-free admission for buffered voice uploads.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  VOICE_UPLOAD_CAPACITY_ERROR_MESSAGE,
  VoiceUploadAdmissionGate,
} from "./voiceUploadAdmission";

describe("VoiceUploadAdmissionGate", () => {
  it("rejects excess uploads until an active lease is released", () => {
    const gate = new VoiceUploadAdmissionGate(2);
    const releaseFirst = gate.tryAcquire();
    const releaseSecond = gate.tryAcquire();

    expect(releaseFirst).toBeTypeOf("function");
    expect(releaseSecond).toBeTypeOf("function");
    expect(gate.tryAcquire()).toBeNull();

    releaseFirst?.();
    expect(gate.tryAcquire()).toBeTypeOf("function");
  });

  it("makes lease release idempotent", () => {
    const gate = new VoiceUploadAdmissionGate(1);
    const release = gate.tryAcquire();

    release?.();
    release?.();

    expect(gate.tryAcquire()).toBeTypeOf("function");
    expect(gate.tryAcquire()).toBeNull();
  });

  it("guards fallback transports with the shared capacity and releases after use", async () => {
    const gate = new VoiceUploadAdmissionGate(1);
    const release = gate.tryAcquire();

    await expect(Effect.runPromise(gate.run(Effect.succeed("blocked")))).rejects.toThrow(
      VOICE_UPLOAD_CAPACITY_ERROR_MESSAGE,
    );
    release?.();
    await expect(Effect.runPromise(gate.run(Effect.succeed("accepted")))).resolves.toBe("accepted");
    expect(gate.tryAcquire()).toBeTypeOf("function");
  });
});
