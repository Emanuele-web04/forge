// FILE: authTokenFile.ts
// Purpose: Read the control-plane auth token from a FILE rather than the
//          environment. This is how a bootstrapped remote server receives the
//          credential the broker minted for it.
// Layer: Server security policy
// Exports: AUTH_TOKEN_FILE_ENV, parseAuthTokenFile, readAuthTokenFile,
//          AuthTokenFileError
//
// Why a file and not an environment variable
// ------------------------------------------
// `/proc/<pid>/environ` is readable by the process owner, and every child
// process inherits the environment wholesale — which for Synara means every
// provider CLI we spawn. A file is readable only through 0600 permissions we
// control, and it can be rotated without restarting the supervisor.

import { readFileSync } from "node:fs";

export const AUTH_TOKEN_FILE_ENV = "SYNARA_AUTH_TOKEN_FILE";

export class AuthTokenFileError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AuthTokenFileError";
  }
}

/**
 * Extract the token from a credential file's raw contents.
 *
 * The file is written with a trailing newline, so trailing whitespace is
 * stripped. An empty or whitespace-only file is an ERROR, never an absent
 * token: silently treating it as "no token configured" would let a truncated
 * write downgrade a remote-reachable server to unauthenticated, which is
 * precisely the failure this credential exists to prevent.
 */
export function parseAuthTokenFile(contents: string, filePath: string): string {
  const token = contents.trim();
  if (token.length === 0) {
    throw new AuthTokenFileError(
      `${AUTH_TOKEN_FILE_ENV} ${filePath} is empty. Refusing to start without the credential it should contain.`,
    );
  }
  // A credential is a single line. Anything else means we are reading a file
  // that is not what we think it is, and guessing which line to trust is worse
  // than refusing.
  if (/[\n\r]/.test(token)) {
    throw new AuthTokenFileError(
      `${AUTH_TOKEN_FILE_ENV} ${filePath} must contain a single-line token.`,
    );
  }
  return token;
}

/** Reads and validates the credential file, throwing AuthTokenFileError. */
export function readAuthTokenFile(filePath: string): string {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new AuthTokenFileError(
      `Failed to read ${AUTH_TOKEN_FILE_ENV} ${filePath}. The server cannot authenticate without it.`,
      { cause },
    );
  }
  return parseAuthTokenFile(contents, filePath);
}

/**
 * Resolve the effective token from the two sources, file taking precedence.
 *
 * Precedence matters: a supervisor unit sets the file, and a stale
 * SYNARA_AUTH_TOKEN inherited from an operator's shell must not silently win
 * over the credential the broker actually provisioned and will present.
 */
export function resolveAuthToken(input: {
  readonly authToken: string | undefined;
  readonly authTokenFile: string | undefined;
  readonly read?: (filePath: string) => string;
}): string | undefined {
  if (input.authTokenFile !== undefined && input.authTokenFile.trim().length > 0) {
    return (input.read ?? readAuthTokenFile)(input.authTokenFile.trim());
  }
  return input.authToken;
}
