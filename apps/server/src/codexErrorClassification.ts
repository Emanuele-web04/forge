// FILE: codexErrorClassification.ts
// Purpose: Centralizes Codex runtime error classification shared across manager and adapter layers.
// Exports: startup failure evidence and helpers for non-fatal Codex error messages

/** Startup failed before a turn could be sent, and process cleanup completed. */
export class CodexSessionStartError extends Error {
  override readonly name = "CodexSessionStartError";
}

const NON_FATAL_CODEX_ERROR_SNIPPETS = [
  "write_stdin failed: stdin is closed for this session",
] as const;

export function isNonFatalCodexErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return NON_FATAL_CODEX_ERROR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}
