// FILE: backendProcessOutput.ts
// Purpose: Tee piped backend output into startup detectors and the configured log destination.

export interface BackendOutputDetector {
  push(chunk: Buffer, source: "stdout" | "stderr"): void;
  end?(source: "stdout" | "stderr"): void;
}

export interface CaptureBackendProcessOutputInput {
  readonly stdout: NodeJS.ReadableStream | null | undefined;
  readonly stderr: NodeJS.ReadableStream | null | undefined;
  readonly writeLog?: ((chunk: Buffer) => void) | undefined;
  readonly writeStdout: (chunk: Buffer) => void;
  readonly writeStderr: (chunk: Buffer) => void;
  readonly detectors: ReadonlyArray<BackendOutputDetector>;
}

export interface BackendProcessOutputCapture {
  /**
   * Resolves after both child streams have closed, so detectors have consumed
   * every buffered chunk before callers classify a process exit.
   */
  readonly drained: Promise<void>;
}

export function captureBackendProcessOutput(
  input: CaptureBackendProcessOutputInput,
): BackendProcessOutputCapture {
  const attachStream = (
    stream: NodeJS.ReadableStream | null | undefined,
    writeFallback: (chunk: Buffer) => void,
    source: "stdout" | "stderr",
  ): Promise<void> => {
    if (!stream) return Promise.resolve();

    stream.on("data", (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (input.writeLog) {
        input.writeLog(buffer);
      } else {
        writeFallback(buffer);
      }
      for (const detector of input.detectors) {
        detector.push(buffer, source);
      }
    });

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = () => {
        if (resolved) return;
        resolved = true;
        for (const detector of input.detectors) {
          detector.end?.(source);
        }
        resolve();
      };
      stream.once("end", resolveOnce);
      stream.once("close", resolveOnce);
      // Child stdio closes after an error; consume the error without treating
      // it as proof that all buffered data events have already been delivered.
      stream.once("error", () => undefined);
    });
  };

  const stdoutDrained = attachStream(input.stdout, input.writeStdout, "stdout");
  const stderrDrained = attachStream(input.stderr, input.writeStderr, "stderr");
  return {
    drained: Promise.all([stdoutDrained, stderrDrained]).then(() => undefined),
  };
}
