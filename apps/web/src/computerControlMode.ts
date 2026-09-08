/** Explicit composer intent, independent of permission grants and active work. */
export type ComposerComputerControlMode = "off" | "request" | "chat";
export function resolveComputerControlMode(
  mode: ComposerComputerControlMode | undefined,
  legacyEnabled?: boolean,
): ComposerComputerControlMode {
  return mode ?? (legacyEnabled === true ? "chat" : "off");
}
