const WINDOWS_RESERVED_DIRECTORY_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function normalizeProjectDirectoryName(value: string): string | null {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.endsWith(".") ||
    normalized.endsWith(" ") ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(normalized) ||
    WINDOWS_RESERVED_DIRECTORY_NAME.test(normalized)
  ) {
    return null;
  }
  return normalized;
}
