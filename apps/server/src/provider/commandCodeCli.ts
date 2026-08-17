export const DEFAULT_COMMAND_CODE_BINARY = process.platform === "win32" ? "cmdc" : "cmd";

/** CommandCode avoids the Windows shell's reserved `cmd` name by installing `cmdc`. */
export function resolveCommandCodeBinaryPath(
  binaryPath: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = binaryPath?.trim();
  if (platform === "win32" && (!normalized || normalized === "cmd")) {
    return "cmdc";
  }
  return normalized || "cmd";
}
