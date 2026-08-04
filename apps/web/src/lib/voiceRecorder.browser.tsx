// FILE: voiceRecorder.browser.tsx
// Purpose: Verifies microphone startup cancellation against real React/browser scheduling.
// Layer: Web browser test
// Depends on: vitest browser hooks and mocked browser media/Web Audio primitives.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { isVoiceRecordingCancelledError, useVoiceRecorder } from "./voiceRecorder";

describe("useVoiceRecorder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not activate recording after cancellation during AudioContext resume", async () => {
    let resolveResume!: () => void;
    const resume = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveResume = resolve;
        }),
    );
    const close = vi.fn(async () => undefined);

    class DeferredAudioContext {
      readonly resume = resume;
      readonly close = close;
    }

    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream);
    vi.stubGlobal("AudioContext", DeferredAudioContext);

    const hook = await renderHook(() => useVoiceRecorder());
    const starting = hook.result.current.startRecording();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));

    await hook.result.current.cancelRecording();
    resolveResume();

    await expect(starting).rejects.toSatisfy(isVoiceRecordingCancelledError);
    expect(hook.result.current.isRecording).toBe(false);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });
});
