// FILE: useComposerVoiceController.test.ts
// Purpose: Covers voice transcription request identity and recorder action guards.
// Layer: Chat composer hook tests

import { ProjectId, ThreadId, type ProviderKind } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  }

  let slots: HookSlot[] = [];
  let cursor = 0;

  const nextSlot = () => {
    const index = cursor;
    cursor += 1;
    slots[index] ??= {};
    return slots[index]!;
  };
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const runEffect = (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const slot = nextSlot();
    if (depsEqual(slot.deps, deps)) {
      return;
    }
    slot.cleanup?.();
    slot.deps = deps;
    const cleanup = effect();
    if (cleanup) {
      slot.cleanup = cleanup;
    } else {
      delete slot.cleanup;
    }
  };

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    unmount() {
      for (const slot of slots.toReversed()) {
        slot.cleanup?.();
      }
    },
    useEffect: runEffect,
    useLayoutEffect: runEffect,
    useRef<T>(initialValue: T) {
      const slot = nextSlot();
      slot.value ??= { current: initialValue };
      return slot.value as { current: T };
    },
    useState<T>(initialValue: T) {
      const slot = nextSlot();
      if (!("value" in slot)) {
        slot.value = initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        slot.value =
          typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
      };
      return [slot.value as T, setValue] as const;
    },
  };
});

const recorder = vi.hoisted(() => ({
  isRecording: true,
  startRecording: vi.fn<() => Promise<void>>(),
  stopRecording: vi.fn(),
  cancelRecording: vi.fn<() => Promise<void>>(),
}));

const nativeApi = vi.hoisted(() => ({
  prewarmVoice: vi.fn(),
  transcribeVoice: vi.fn(),
  available: true,
}));

const toast = vi.hoisted(() => ({ add: vi.fn() }));
const voiceAvailability = vi.hoisted(() => ({
  canStartVoiceNotes: true,
  showVoiceNotesControl: true,
}));

vi.mock("react", () => ({
  useEffect: reactHarness.useEffect,
  useLayoutEffect: reactHarness.useLayoutEffect,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

vi.mock("../../lib/voiceRecorder", () => ({
  formatVoiceRecordingDuration: () => "0:00",
  isVoiceRecordingCancelledError: (error: unknown) =>
    error instanceof Error && error.name === "VoiceRecordingCancelledError",
  useVoiceRecorder: () => ({
    isRecording: recorder.isRecording,
    durationMs: 0,
    waveformLevels: [],
    startRecording: recorder.startRecording,
    stopRecording: recorder.stopRecording,
    cancelRecording: recorder.cancelRecording,
  }),
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () =>
    nativeApi.available
      ? {
          server: {
            prewarmVoice: nativeApi.prewarmVoice,
            transcribeVoice: nativeApi.transcribeVoice,
          },
        }
      : null,
}));

vi.mock("../ui/toast", () => ({ toastManager: toast }));

vi.mock("../ChatView.logic", () => ({
  deriveComposerVoiceState: () => ({ ...voiceAvailability }),
  describeVoiceRecordingStartError: (error: unknown) => String(error),
  isVoiceAuthExpiredMessage: (message: string) => message.includes("expired"),
  sanitizeVoiceErrorMessage: (message: string) => message,
}));

import type { Project } from "../../types";
import {
  useComposerVoiceController,
  type UseComposerVoiceControllerOptions,
  type UseComposerVoiceControllerResult,
} from "./useComposerVoiceController";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const PROJECT: Project = {
  id: ProjectId.makeUnsafe("project-a"),
  kind: "project",
  name: "Project",
  remoteName: "Project",
  folderName: "project",
  localName: null,
  cwd: "/workspace/project",
  defaultModelSelection: null,
  expanded: true,
  scripts: [],
};
const AUDIO_PAYLOAD = {
  audioBase64: "audio",
  mimeType: "audio/wav" as const,
  sampleRateHz: 24_000,
  durationMs: 500,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useComposerVoiceController", () => {
  let options: UseComposerVoiceControllerOptions;
  let result: UseComposerVoiceControllerResult;

  const render = (overrides: Partial<UseComposerVoiceControllerOptions> = {}) => {
    options = { ...options, ...overrides };
    reactHarness.beginRender();
    result = useComposerVoiceController(options);
    return result;
  };

  beforeEach(async () => {
    reactHarness.reset();
    recorder.isRecording = true;
    recorder.startRecording.mockReset().mockResolvedValue(undefined);
    recorder.stopRecording.mockReset().mockResolvedValue(AUDIO_PAYLOAD);
    recorder.cancelRecording.mockReset().mockResolvedValue(undefined);
    nativeApi.prewarmVoice.mockReset().mockResolvedValue({ ready: true });
    nativeApi.transcribeVoice.mockReset().mockResolvedValue({ text: "transcribed once" });
    nativeApi.available = true;
    voiceAvailability.canStartVoiceNotes = true;
    voiceAvailability.showVoiceNotesControl = true;
    toast.add.mockReset();
    options = {
      activeProject: PROJECT,
      activeThreadId: THREAD_A,
      threadId: THREAD_A,
      selectedProvider: "codex",
      activeProviderStatus: null,
      pendingUserInputCount: 0,
      onTranscriptReady: vi.fn(),
      refreshVoiceStatus: vi.fn(),
    };
    render();
    await Promise.resolve();
    recorder.cancelRecording.mockClear();
  });

  it("applies a successful transcription exactly once", async () => {
    await result.submitComposerVoiceRecording();

    expect(options.onTranscriptReady).toHaveBeenCalledTimes(1);
    expect(options.onTranscriptReady).toHaveBeenCalledWith("transcribed once");
  });

  it("discards the active recording without stopping or transcribing it", () => {
    result.cancelComposerVoiceRecording();

    expect(recorder.cancelRecording).toHaveBeenCalledTimes(1);
    expect(recorder.stopRecording).not.toHaveBeenCalled();
    expect(nativeApi.transcribeVoice).not.toHaveBeenCalled();
    expect(options.onTranscriptReady).not.toHaveBeenCalled();
  });

  it("prewarms persistent voice state after recording starts", async () => {
    recorder.isRecording = false;
    render();

    await result.startComposerVoiceRecording();

    expect(nativeApi.prewarmVoice).toHaveBeenCalledWith({
      provider: "codex",
      cwd: PROJECT.cwd,
      threadId: THREAD_A,
    });
  });

  it.each(["thread", "provider", "cancel"] as const)(
    "ignores a stale transcription after %s changes",
    async (staleCause) => {
      const transcription = deferred<{ text: string }>();
      nativeApi.transcribeVoice.mockReturnValueOnce(transcription.promise);

      const submission = result.submitComposerVoiceRecording();
      await vi.waitFor(() => expect(nativeApi.transcribeVoice).toHaveBeenCalledTimes(1));

      if (staleCause === "thread") {
        render({ activeThreadId: THREAD_B, threadId: THREAD_B });
      } else if (staleCause === "provider") {
        render({ selectedProvider: "claudeAgent" as ProviderKind });
      } else {
        result.cancelComposerVoiceRecording();
      }

      transcription.resolve({ text: "stale" });
      await submission;
      render();

      expect(options.onTranscriptReady).not.toHaveBeenCalled();
      expect(result.isVoiceTranscribing).toBe(false);
    },
  );

  it("does not surface recorder startup cancellation as an error", async () => {
    recorder.isRecording = false;
    recorder.startRecording.mockRejectedValueOnce(
      Object.assign(new Error("Voice recording was cancelled."), {
        name: "VoiceRecordingCancelledError",
      }),
    );
    render();

    await result.startComposerVoiceRecording();

    expect(toast.add).not.toHaveBeenCalled();
    expect(nativeApi.prewarmVoice).not.toHaveBeenCalled();
  });

  it("surfaces a genuine browser AbortError from microphone startup", async () => {
    recorder.isRecording = false;
    recorder.startRecording.mockRejectedValueOnce(
      new DOMException("The microphone could not start.", "AbortError"),
    );
    render();

    await result.startComposerVoiceRecording();

    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not start recording" }),
    );
  });

  it("invalidates an in-flight transcript when the composer unmounts", async () => {
    const transcription = deferred<{ text: string }>();
    nativeApi.transcribeVoice.mockReturnValueOnce(transcription.promise);

    const submission = result.submitComposerVoiceRecording();
    await vi.waitFor(() => expect(nativeApi.transcribeVoice).toHaveBeenCalledTimes(1));
    reactHarness.unmount();
    transcription.resolve({ text: "stale after unmount" });
    await submission;

    expect(options.onTranscriptReady).not.toHaveBeenCalled();
  });

  it("blocks submit and cancel until the configured action-arm delay elapses", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    recorder.isRecording = false;
    render({ actionArmDelayMs: 250, onGuardWarning: vi.fn() });

    await result.startComposerVoiceRecording();
    recorder.isRecording = true;
    render();
    recorder.cancelRecording.mockClear();
    now = 1_100;

    await result.submitComposerVoiceRecording();
    result.cancelComposerVoiceRecording();

    expect(recorder.stopRecording).not.toHaveBeenCalled();
    expect(recorder.cancelRecording).not.toHaveBeenCalled();
    expect(options.onGuardWarning).toHaveBeenCalledTimes(2);
  });

  it("supports ChatView-specific transcription failure copy without changing defaults", async () => {
    nativeApi.transcribeVoice.mockRejectedValueOnce(new Error("network failed"));
    render({
      failureCopy: {
        transcriptionFailedTitle: "Couldn't transcribe voice note",
      },
    });

    await result.submitComposerVoiceRecording();

    expect(toast.add).toHaveBeenCalledWith({
      type: "error",
      title: "Couldn't transcribe voice note",
      description: "network failed",
    });
  });

  it("refreshes status for expired auth and keeps the refresh action available", async () => {
    nativeApi.transcribeVoice.mockRejectedValueOnce(new Error("session expired"));

    await result.submitComposerVoiceRecording();

    expect(options.refreshVoiceStatus).toHaveBeenCalledTimes(1);
    const failureToast = toast.add.mock.calls.at(-1)?.[0];
    expect(failureToast).toMatchObject({
      title: "Sign in to ChatGPT again",
      actionProps: { children: "Refresh status" },
    });
    failureToast?.actionProps?.onClick();
    expect(options.refreshVoiceStatus).toHaveBeenCalledTimes(2);
  });

  it("cancels and invalidates transcription when voice becomes unavailable", async () => {
    const transcription = deferred<{ text: string }>();
    nativeApi.transcribeVoice.mockReturnValueOnce(transcription.promise);
    recorder.cancelRecording.mockImplementationOnce(async () => {
      recorder.isRecording = false;
    });

    const submission = result.submitComposerVoiceRecording();
    await vi.waitFor(() => expect(nativeApi.transcribeVoice).toHaveBeenCalledTimes(1));

    voiceAvailability.canStartVoiceNotes = false;
    render({
      activeProviderStatus: {
        provider: "codex",
        status: "error",
        available: false,
        authStatus: "unauthenticated",
        voiceTranscriptionAvailable: false,
        checkedAt: "2026-07-20T00:00:00.000Z",
      },
    });
    await vi.waitFor(() => expect(recorder.cancelRecording).toHaveBeenCalledTimes(1));
    render();

    expect(result.isVoiceRecording).toBe(false);
    expect(result.isVoiceTranscribing).toBe(false);

    transcription.resolve({ text: "stale after availability loss" });
    await submission;
    expect(options.onTranscriptReady).not.toHaveBeenCalled();
  });

  it("does not let an older availability cancellation clear a newer transcription", async () => {
    const firstTranscription = deferred<{ text: string }>();
    const secondTranscription = deferred<{ text: string }>();
    const cancellation = deferred<void>();
    nativeApi.transcribeVoice
      .mockReturnValueOnce(firstTranscription.promise)
      .mockReturnValueOnce(secondTranscription.promise);
    recorder.cancelRecording.mockReturnValueOnce(cancellation.promise);

    const firstSubmission = result.submitComposerVoiceRecording();
    await vi.waitFor(() => expect(nativeApi.transcribeVoice).toHaveBeenCalledTimes(1));

    voiceAvailability.canStartVoiceNotes = false;
    render();
    await vi.waitFor(() => expect(recorder.cancelRecording).toHaveBeenCalledTimes(1));

    voiceAvailability.canStartVoiceNotes = true;
    render();
    const secondSubmission = result.submitComposerVoiceRecording();
    await vi.waitFor(() => expect(nativeApi.transcribeVoice).toHaveBeenCalledTimes(2));

    cancellation.resolve();
    await cancellation.promise;
    render();
    expect(result.isVoiceTranscribing).toBe(true);

    firstTranscription.resolve({ text: "stale first transcript" });
    secondTranscription.resolve({ text: "current second transcript" });
    await Promise.all([firstSubmission, secondSubmission]);

    expect(options.onTranscriptReady).toHaveBeenCalledTimes(1);
    expect(options.onTranscriptReady).toHaveBeenCalledWith("current second transcript");
  });
});
