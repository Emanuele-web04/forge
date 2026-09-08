// FILE: providerLaunchArgs.ts
// Purpose: Parse user-supplied provider CLI launch args into argv tokens.
// Layer: Shared runtime utility
// Exports: ProviderLaunchArgsError, parseProviderLaunchArgs, buildCodexAppServerArgs

export class ProviderLaunchArgsError extends Error {
  readonly _tag = "ProviderLaunchArgsError";

  constructor(message: string) {
    super(message);
    this.name = "ProviderLaunchArgsError";
  }
}

export interface ParsedProviderLaunchArgs {
  readonly prefix: readonly string[];
  readonly suffix: readonly string[];
}

/**
 * Tokenize a launch-args string with POSIX-style quoting.
 *
 * An unquoted `--` splits global flags (inserted before the provider subcommand)
 * from subcommand flags (appended after it).
 */
export function parseProviderLaunchArgs(input: string): ParsedProviderLaunchArgs {
  const tokens = tokenizeProviderLaunchArgs(input);
  const separator = tokens.indexOf("--");
  if (separator === -1) {
    return { prefix: tokens, suffix: [] };
  }
  return {
    prefix: tokens.slice(0, separator),
    suffix: tokens.slice(separator + 1),
  };
}

/** Build `codex <prefix> app-server <suffix>` from an optional launch-args string. */
export function buildCodexAppServerArgs(launchArgs?: string): string[] {
  const { prefix, suffix } = parseProviderLaunchArgs(launchArgs ?? "");
  return [...prefix, "app-server", ...suffix];
}

function tokenizeProviderLaunchArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escapeNext = false;

  for (const char of input.trim()) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = quote !== "'";
      if (!escapeNext) {
        current += char;
      }
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escapeNext) {
    throw new ProviderLaunchArgsError("Codex launch args end with a dangling backslash.");
  }
  if (quote !== null) {
    throw new ProviderLaunchArgsError(`Codex launch args have an unmatched ${quote} quote.`);
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
