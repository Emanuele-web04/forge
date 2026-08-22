// FILE: runtimeSelection.ts
// Purpose: Selects the PTY implementation for the current JavaScript runtime and host platform.
// Layer: Terminal infrastructure

export type PtyAdapterRuntime = "bun" | "node";

export function selectPtyAdapterRuntime(input: {
  readonly platform: NodeJS.Platform;
  readonly runtime: PtyAdapterRuntime;
}): PtyAdapterRuntime {
  // node-pty ships a Windows ConPTY binding and can be loaded from Bun, so use
  // the same stable implementation under either JavaScript runtime on Windows.
  return input.platform === "win32" ? "node" : input.runtime;
}
