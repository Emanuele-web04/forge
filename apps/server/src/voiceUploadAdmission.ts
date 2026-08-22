// FILE: voiceUploadAdmission.ts
// Purpose: Bounds voice uploads before request bodies are buffered in server memory.
// Layer: Server transport utility
// Exports: VoiceUploadAdmissionGate, voiceUploadAdmissionGate

import { Effect } from "effect";

const MAX_CONCURRENT_VOICE_UPLOADS = 2;
export const VOICE_UPLOAD_CAPACITY_ERROR_MESSAGE =
  "Too many voice uploads are already in progress. Try again shortly.";

export class VoiceUploadAdmissionGate {
  private active = 0;

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("Voice upload concurrency must be a positive integer.");
    }
  }

  tryAcquire(): (() => void) | null {
    if (this.active >= this.maxConcurrent) {
      return null;
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
    };
  }

  run<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Error, R> {
    const acquire = Effect.sync(() => this.tryAcquire()).pipe(
      Effect.flatMap((release) =>
        release
          ? Effect.succeed(release)
          : Effect.fail(new Error(VOICE_UPLOAD_CAPACITY_ERROR_MESSAGE)),
      ),
    );
    return Effect.acquireUseRelease(
      acquire,
      () => effect,
      (release) => Effect.sync(release),
    );
  }
}

export const voiceUploadAdmissionGate = new VoiceUploadAdmissionGate(MAX_CONCURRENT_VOICE_UPLOADS);
