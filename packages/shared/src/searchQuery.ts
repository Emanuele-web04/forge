// FILE: searchQuery.ts
// Purpose: Canonical normalization for workspace ENTRY (file/directory name)
//          search queries. The server ranker and the web match highlighter must
//          agree on what counts as the query — when they drift, a result can
//          match server-side while the client renders it with no emphasis
//          (e.g. typing "./comp" for Composer.tsx).
// Layer: Shared runtime utility
// Exports: normalizeWorkspaceEntrySearchQuery
//
// Scope note: this is specific to entry-name search. Content (snippet) search
// does not strip prefixes, and local filesystem search has its own dotfile
// semantics — neither should adopt this normalizer.

/**
 * Trims, strips leading "@" / "." / "/" prefixes (mention syntax and relative
 * path noise), and lowercases.
 */
export function normalizeWorkspaceEntrySearchQuery(input: string): string {
  return input
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase();
}
