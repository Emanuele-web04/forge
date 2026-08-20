import { Effect, Layer } from "effect";

import {
  browseWorkspaceEntries,
  clearWorkspaceIndexCache,
  discoverProjectScripts,
  listWorkspaceDirectories,
  prewarmWorkspaceSearchIndex,
  resolveWorkspaceFileBySuffix,
  searchLocalEntries,
  searchWorkspaceContent,
  searchWorkspaceEntries,
} from "../../workspaceEntries";
import { toWorkspaceEntriesError, WorkspaceEntries } from "../Services/WorkspaceEntries";

export const WorkspaceEntriesLive = Layer.succeed(WorkspaceEntries, {
  browse: (input) =>
    Effect.tryPromise({
      try: () => browseWorkspaceEntries(input),
      catch: (cause) => toWorkspaceEntriesError("browse filesystem", cause),
    }),
  search: (input) =>
    Effect.tryPromise({
      try: () => searchWorkspaceEntries(input),
      catch: (cause) => toWorkspaceEntriesError("search workspace entries", cause),
    }),
  searchContent: (input) =>
    Effect.tryPromise({
      try: () => searchWorkspaceContent(input),
      catch: (cause) => toWorkspaceEntriesError("search workspace content", cause),
    }),
  prewarmSearchIndex: (input) => Effect.sync(() => prewarmWorkspaceSearchIndex(input)),
  discoverScripts: (input) =>
    Effect.tryPromise({
      try: () => discoverProjectScripts(input),
      catch: (cause) => toWorkspaceEntriesError("discover project scripts", cause),
    }),
  listDirectories: (input) =>
    Effect.tryPromise({
      try: () => listWorkspaceDirectories(input),
      catch: (cause) => toWorkspaceEntriesError("list workspace directories", cause),
    }),
  searchLocal: (input) =>
    Effect.tryPromise({
      try: () => searchLocalEntries(input),
      catch: (cause) => toWorkspaceEntriesError("search local entries", cause),
    }),
  resolveFileBySuffix: (input) =>
    Effect.tryPromise({
      try: () => resolveWorkspaceFileBySuffix(input),
      catch: (cause) => toWorkspaceEntriesError("resolve workspace file by suffix", cause),
    }),
  invalidate: (cwd) => Effect.sync(() => clearWorkspaceIndexCache(cwd)),
});
