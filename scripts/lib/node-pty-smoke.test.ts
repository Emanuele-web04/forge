import { assert, describe, it } from "vitest";

import { type PtyTerminal, waitForSuccessfulPtyExit } from "./node-pty-smoke.ts";

class FakePtyTerminal implements PtyTerminal {
  private dataListener: (chunk: string) => void = () => {};
  private exitListener: (event: { readonly exitCode: number }) => void = () => {};

  readonly kill = () => {};

  readonly onData = (listener: (chunk: string) => void) => {
    this.dataListener = listener;
    return { dispose: () => (this.dataListener = () => {}) };
  };

  readonly onExit = (listener: (event: { readonly exitCode: number }) => void) => {
    this.exitListener = listener;
    return { dispose: () => (this.exitListener = () => {}) };
  };

  emitData(chunk: string) {
    this.dataListener(chunk);
  }

  emitExit(exitCode: number) {
    this.exitListener({ exitCode });
  }
}

describe("waitForSuccessfulPtyExit", () => {
  it("accepts output delivered after the PTY exit event", async () => {
    const terminal = new FakePtyTerminal();
    const result = waitForSuccessfulPtyExit({
      terminal,
      expectedOutput: "synara-node-pty-smoke",
      timeoutMs: 1_000,
    });

    terminal.emitExit(0);
    terminal.emitData("synara-node-pty-smoke");

    assert.equal(await result, "synara-node-pty-smoke");
  });

  it("still accepts the usual output-before-exit ordering", async () => {
    const terminal = new FakePtyTerminal();
    const result = waitForSuccessfulPtyExit({
      terminal,
      expectedOutput: "synara-node-pty-smoke",
      timeoutMs: 1_000,
    });

    terminal.emitData("synara-node-pty-smoke");
    terminal.emitExit(0);

    assert.equal(await result, "synara-node-pty-smoke");
  });
});
