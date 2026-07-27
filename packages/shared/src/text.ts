// FILE: text.ts
// Purpose: Small, dependency-free text helpers shared across server and web so
// repeated string semantics (count pluralization, etc.) live in one place.
// Layer: Shared runtime utility
// Exports: pluralize, nonEmptyTrimmed

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
