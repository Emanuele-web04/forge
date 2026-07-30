// FILE: remoteInputs.ts
// Purpose: Validate every caller-influenced component of a remote path or
//          command. Each value here becomes a path segment, a unit-file field,
//          or an argv token on a machine we do not own, so all of them are
//          treated as untrusted and validated at the boundary rather than
//          escaped at each use site.
// Layer: Server / remote broker
// Exports: normalizeReleaseId, isValidReleaseId, containsControlCharacter,
//          normalizeRemoteFileName, isValidRemoteFileName, normalizeEnvironmentId

/**
 * A release id becomes a directory name under the install root and a systemd
 * unit's WorkingDirectory. It is derived from a version string that ultimately
 * came from a release artifact, so it is treated as untrusted input: only
 * characters that are inert in a path AND in a unit file are accepted.
 *
 * Rejecting is the whole point — `..`, `/`, NUL, newline, and `%` (a systemd
 * specifier escape) must never reach a path or a unit.
 */
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * True when a string contains a NUL, newline, carriage return, or any other C0
 * control character.
 *
 * Written as a code-point scan rather than a regex so the intent is explicit
 * and so no escaping subtlety can quietly narrow what it catches. Control
 * characters are the tokens that split a systemd unit line, terminate a path,
 * or forge a second command, so this is a hard reject everywhere it is used.
 */
export function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isValidReleaseId(value: string): boolean {
  if (!RELEASE_ID_PATTERN.test(value)) return false;
  // Belt and braces: the pattern already excludes `/`, but a value consisting
  // only of dots would still be a traversal segment.
  return !/^\.+$/.test(value) && !value.includes("..");
}

export function normalizeReleaseId(value: string): string {
  const trimmed = value.trim();
  if (!isValidReleaseId(trimmed)) {
    throw new Error(`Invalid remote release id: ${JSON.stringify(value)}`);
  }
  return trimmed;
}

/**
 * A staged artifact's file name is joined onto the staging directory and then
 * handed to `tar` as an operand, so it has to be inert in BOTH positions.
 *
 * The leading-character restriction is what stops it being read as a flag: a
 * name like `--checkpoint-action=exec=sh` is a documented arbitrary-execution
 * vector in GNU tar. The `--` separator at each call site is the second half of
 * that defence; this is the first, because a value that can never look like a
 * flag does not depend on every future call site remembering the separator.
 */
const REMOTE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidRemoteFileName(value: string): boolean {
  if (!REMOTE_FILE_NAME_PATTERN.test(value)) return false;
  // The pattern already excludes `/`, but a name made only of dots would still
  // be a traversal segment.
  return !/^\.+$/.test(value) && !value.includes("..");
}

export function normalizeRemoteFileName(value: string): string {
  const trimmed = value.trim();
  if (!isValidRemoteFileName(trimmed)) {
    throw new Error(`Invalid remote artifact file name: ${JSON.stringify(value)}`);
  }
  return trimmed;
}

/**
 * The environment id is what the provisioning handshake compares to decide
 * whether the server answering the forwarded port is the one we installed.
 *
 * Requiring a UUID here is what makes that comparison meaningful: an empty
 * string compares equal to an empty string, so an unvalidated id would turn the
 * strongest identity check in the bootstrap into a tautology.
 */
const ENVIRONMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeEnvironmentId(value: string): string {
  const trimmed = value.trim();
  if (!ENVIRONMENT_ID_PATTERN.test(trimmed)) {
    throw new Error(`Invalid remote environment id: ${JSON.stringify(value)}`);
  }
  return trimmed.toLowerCase();
}
