// FILE: posixShell.ts
// Purpose: POSIX shell argument quoting — the single encoder used anywhere a
//          value has to survive a shell, whether that shell is a local PTY or a
//          remote login shell reached over SSH.
// Layer: Shared protocol/security utility
// Exports: quotePosixShellArgument, quotePosixShellCommand

const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a value so it can be passed as a single argument to a POSIX shell.
 *
 * Strings that already consist of only "safe" characters are returned unchanged
 * to keep the visible terminal output readable; everything else is wrapped in
 * single quotes, with embedded single quotes escaped via the standard
 * `'\''` close-quote/escape/open-quote sequence.
 */
export function quotePosixShellArgument(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  if (SAFE_TOKEN_PATTERN.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Encode an argv vector as a single POSIX shell word list.
 *
 * This exists because some transports (notably `ssh host <command>`) hand their
 * payload to a remote login shell no matter what the caller does: the remote
 * side always runs `$SHELL -c "<string>"`. The only safe response is to build
 * the argv locally and encode it here, so that every element stays exactly one
 * token on the far side. Never interpolate a value into a command string by
 * hand — route it through this function.
 */
export function quotePosixShellCommand(argv: ReadonlyArray<string>): string {
  if (argv.length === 0) {
    throw new Error("Cannot encode an empty argv as a shell command");
  }
  return argv.map(quotePosixShellArgument).join(" ");
}
