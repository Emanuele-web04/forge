interface Disposable {
  readonly dispose: () => void;
}

interface PtyExitEvent {
  readonly exitCode: number;
}

export interface PtyTerminal {
  readonly kill: () => void;
  readonly onData: (listener: (chunk: string) => void) => Disposable;
  readonly onExit: (listener: (event: PtyExitEvent) => void) => Disposable;
}

interface PtySmokeOptions {
  readonly terminal: PtyTerminal;
  readonly expectedOutput: string;
  readonly timeoutMs: number;
}

export function waitForSuccessfulPtyExit({
  terminal,
  expectedOutput,
  timeoutMs,
}: PtySmokeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let exitCode: number | null = null;
    let settled = false;
    let dataSubscription: Disposable | null = null;
    let exitSubscription: Disposable | null = null;

    const cleanup = () => {
      clearTimeout(timeout);
      dataSubscription?.dispose();
      exitSubscription?.dispose();
    };

    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };

    const fail = (message: string) => {
      const detail = output.length > 0 ? `\n${output}` : "";
      settle(() => reject(new Error(`${message}${detail}`)));
    };

    const completeWhenReady = () => {
      if (exitCode === null) return;
      if (exitCode !== 0) {
        fail(`PTY process exited with code ${exitCode}.`);
        return;
      }
      if (!output.includes(expectedOutput)) return;
      settle(() => resolve(output));
    };

    const timeout = setTimeout(() => {
      if (exitCode === null) {
        try {
          terminal.kill();
        } catch {
          // The timeout remains the actionable failure when cleanup cannot kill the PTY.
        }
        fail("Timed out waiting for node-pty output.");
        return;
      }
      fail(`Expected PTY output "${expectedOutput}" was not observed.`);
    }, timeoutMs);

    dataSubscription = terminal.onData((chunk) => {
      output += chunk;
      completeWhenReady();
    });
    exitSubscription = terminal.onExit((event) => {
      exitCode = event.exitCode;
      completeWhenReady();
    });
  });
}
