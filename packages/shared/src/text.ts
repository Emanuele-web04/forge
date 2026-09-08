// FILE: text.ts
// Purpose: Small, dependency-free text helpers shared across server and web so
// repeated string semantics (count pluralization, etc.) live in one place.
// Layer: Shared runtime utility
// Exports: normalizeLineEndings, pluralize, nonEmptyTrimmed, splitsSurrogatePair, unicodeSafeEndOffset

// Workspace text buffers use LF; retain the separate on-disk format metadata
// when this representation is used for editing or comparison.
export function normalizeLineEndings(contents: string): string {
  return contents.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

// Reports whether a UTF-16 offset falls between the high and low surrogate of
// one Unicode code point. JavaScript string lengths and slice offsets count
// UTF-16 code units, so bounded text must account for this boundary explicitly.
export function splitsSurrogatePair(text: string, offsetChars: number): boolean {
  if (offsetChars <= 0 || offsetChars >= text.length) return false;
  const previousCodeUnit = text.charCodeAt(offsetChars - 1);
  const nextCodeUnit = text.charCodeAt(offsetChars);
  return (
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  );
}

// Keeps a prefix within its existing UTF-16 budget without leaving an
// unpaired high surrogate at the end. At most one code unit is removed.
export function unicodeSafeEndOffset(text: string, requestedEndOffsetChars: number): number {
  return splitsSurrogatePair(text, requestedEndOffsetChars)
    ? requestedEndOffsetChars - 1
    : requestedEndOffsetChars;
}

// Normalizes an optional string to "present and meaningful" or absent.
//
// `??` only falls back on null/undefined, so a blank or whitespace-only string
// slips through every `a ?? b ?? fallback` chain. That matters because many
// contract fields are `TrimmedNonEmptyString`: a `""` satisfies TypeScript but
// is rejected by the schema at the boundary, and branded `makeUnsafe`
// constructors validate without normalizing, so an untrimmed value throws.
// Use this wherever a string travels from provider output into a command.
export function nonEmptyTrimmed(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Returns the singular or plural form of a noun based on `count`. The plural
// defaults to `${singular}s`; pass an explicit plural for irregular forms or
// when a verb travels with the noun (e.g. "thread is" / "threads are").
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
