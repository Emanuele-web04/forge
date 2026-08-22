// FILE: matchHighlight.ts
// Purpose: Split a label into matched/unmatched runs for a search query so result
//          rows can emphasise the characters the search matched on. This is an
//          independent client-side approximation of the server ranking in
//          `workspaceEntries.ts` (contiguous substring preferred, then a
//          left-to-right subsequence walk) — it is NOT guaranteed to reproduce
//          the exact runs that earned the server score. Callers searching file
//          entries must pass a query normalized with
//          `normalizeWorkspaceEntrySearchQuery` (@synara/shared/searchQuery),
//          matching what the server actually matched against.
// Layer: Web UI utility
// Exports: MatchSegment, buildMatchSegments

export interface MatchSegment {
  text: string;
  matched: boolean;
  /** Offset of this run inside the original text; doubles as a stable render key. */
  start: number;
}

/** Indices of `needle` inside `haystack` as a left-to-right subsequence, or null. */
function findSubsequenceIndices(haystack: string, needle: string): number[] | null {
  const indices: number[] = [];
  let needleIndex = 0;

  for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
    if (haystack[index] === needle[needleIndex]) {
      indices.push(index);
      needleIndex += 1;
    }
  }

  return needleIndex === needle.length ? indices : null;
}

/** Collapse matched indices into runs so adjacent hits render as one emphasised span. */
function segmentsFromIndices(text: string, indices: number[]): MatchSegment[] {
  const segments: MatchSegment[] = [];
  let cursor = 0;
  let position = 0;

  while (position < indices.length) {
    const start = indices[position] as number;
    let end = start + 1;
    while (position + 1 < indices.length && indices[position + 1] === end) {
      end += 1;
      position += 1;
    }
    position += 1;

    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), matched: false, start: cursor });
    }
    segments.push({ text: text.slice(start, end), matched: true, start });
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), matched: false, start: cursor });
  }

  return segments;
}

/**
 * Returns the matched/unmatched runs of `text` for `query`, or null when the query
 * does not occur in the text at all (the caller then renders the label unemphasised).
 */
export function buildMatchSegments(text: string, query: string): MatchSegment[] | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0 || text.length === 0) return null;

  const normalizedText = text.toLowerCase();
  // A few code points change length when lowercased (e.g. "İ"), which would desync
  // the indices from the original string. Rare enough to simply skip emphasis.
  if (normalizedText.length !== text.length) return null;

  const contiguousStart = normalizedText.indexOf(normalizedQuery);
  if (contiguousStart !== -1) {
    const indices: number[] = [];
    for (let offset = 0; offset < normalizedQuery.length; offset += 1) {
      indices.push(contiguousStart + offset);
    }
    return segmentsFromIndices(text, indices);
  }

  const subsequenceIndices = findSubsequenceIndices(normalizedText, normalizedQuery);
  return subsequenceIndices ? segmentsFromIndices(text, subsequenceIndices) : null;
}
