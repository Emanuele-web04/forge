const WINDOWS_RESERVED_DIRECTORY_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_DIRECTORY_NAME_UTF8_BYTES = 255;
const UTF8_ENCODER = new TextEncoder();

export function normalizeProjectDirectoryName(value: string): string | null {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    UTF8_ENCODER.encode(normalized).byteLength > MAX_DIRECTORY_NAME_UTF8_BYTES ||
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
