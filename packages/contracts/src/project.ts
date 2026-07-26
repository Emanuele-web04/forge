import { Schema } from "effect";
import {
  NonNegativeInt,
  PositiveInt,
  ProcessEnvRecord,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_LOCAL_ENTRIES_MAX_LIMIT = 100;
const PROJECT_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 2048;
const PROJECT_READ_FILE_MAX_BYTES = 1_000_000;
const PROJECT_DIRECTORY_LIST_MAX_DEPTH = 32;
const PROJECT_SCRIPT_DISCOVERY_MAX_DEPTH = 3;
const PROJECT_REMOTE_HOST_MAX_LENGTH = 256;
const PROJECT_REMOTE_SSH_ARG_MAX_LENGTH = 512;
const PROJECT_REMOTE_SSH_ARGS_MAX_COUNT = 32;
const PROJECT_REMOTE_SHELL_INIT_MAX_LENGTH = 1024;
const PROJECT_REMOTE_BINARY_PATH_MAX_LENGTH = 512;
const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectKind = Schema.Literals(["project", "chat", "studio"]);
export type ProjectKind = typeof ProjectKind.Type;

/**
 * SSH target for a project whose workspace lives on another machine.
 *
 * Synara deliberately owns none of the connection setup: `host` is any ssh(1)
 * destination, so a `~/.ssh/config` Host alias already carries the user's port,
 * identity, jump hosts, ProxyCommand and multiplexing exactly as their terminal
 * uses them. `sshArgs` is the escape hatch for people who do not keep an ssh
 * config, and `shellInit` covers non-interactive shells that need a version
 * manager or credential export before the agent binary is reachable.
 */
export const ProjectRemote = Schema.Struct({
  kind: Schema.Literal("ssh"),
  /** ssh destination: a `~/.ssh/config` Host alias or `[user@]hostname`. */
  host: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_REMOTE_HOST_MAX_LENGTH)),
  /** Extra ssh flags, already tokenized (e.g. `["-p", "2222", "-J", "bastion"]`). */
  sshArgs: Schema.optional(
    Schema.Array(
      TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_REMOTE_SSH_ARG_MAX_LENGTH)),
    ).check(Schema.isMaxLength(PROJECT_REMOTE_SSH_ARGS_MAX_COUNT)),
  ).pipe(Schema.withDecodingDefault(() => [])),
  /** Shell command run on the remote before the agent, e.g. `source ~/.nvm/nvm.sh`. */
  shellInit: Schema.optional(
    Schema.NullOr(
      TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_REMOTE_SHELL_INIT_MAX_LENGTH)),
    ),
  ).pipe(Schema.withDecodingDefault(() => null)),
  /** Agent binary as resolved on the remote host; defaults to the provider's own default. */
  binaryPath: Schema.optional(
    Schema.NullOr(
      TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_REMOTE_BINARY_PATH_MAX_LENGTH)),
    ),
  ).pipe(Schema.withDecodingDefault(() => null)),
});
export type ProjectRemote = typeof ProjectRemote.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectDirectoryEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  parentPath: Schema.optional(TrimmedNonEmptyString),
  hasChildren: Schema.Boolean,
});
export type ProjectDirectoryEntry = typeof ProjectDirectoryEntry.Type;

export const ProjectFileSystemEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  parentPath: Schema.optional(TrimmedNonEmptyString),
  kind: ProjectEntryKind,
  hasChildren: Schema.optional(Schema.Boolean),
});
export type ProjectFileSystemEntry = typeof ProjectFileSystemEntry.Type;

export const ProjectListDirectoriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  depth: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_DIRECTORY_LIST_MAX_DEPTH)),
  ),
  includeFiles: Schema.optional(Schema.Boolean),
});
export type ProjectListDirectoriesInput = typeof ProjectListDirectoriesInput.Type;

export const ProjectListDirectoriesResult = Schema.Struct({
  entries: Schema.Array(ProjectFileSystemEntry),
});
export type ProjectListDirectoriesResult = typeof ProjectListDirectoriesResult.Type;

export const ProjectDiscoverScriptsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  depth: Schema.optional(
    NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROJECT_SCRIPT_DISCOVERY_MAX_DEPTH)),
  ),
});
export type ProjectDiscoverScriptsInput = typeof ProjectDiscoverScriptsInput.Type;

export const ProjectDiscoveredScript = Schema.Struct({
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
});
export type ProjectDiscoveredScript = typeof ProjectDiscoveredScript.Type;

export const ProjectDiscoveredScriptTarget = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.String,
  packageJsonPath: TrimmedNonEmptyString,
  packageName: Schema.optional(TrimmedNonEmptyString),
  scripts: Schema.Array(ProjectDiscoveredScript),
});
export type ProjectDiscoveredScriptTarget = typeof ProjectDiscoveredScriptTarget.Type;

export const ProjectDiscoverScriptsResult = Schema.Struct({
  targets: Schema.Array(ProjectDiscoveredScriptTarget),
});
export type ProjectDiscoverScriptsResult = typeof ProjectDiscoverScriptsResult.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectSearchLocalEntriesInput = Schema.Struct({
  rootPath: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_LOCAL_ENTRIES_MAX_LIMIT)),
  ),
  includeFiles: Schema.optional(Schema.Boolean),
});
export type ProjectSearchLocalEntriesInput = typeof ProjectSearchLocalEntriesInput.Type;

export const ProjectLocalSearchEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  parentPath: Schema.optional(TrimmedNonEmptyString),
  kind: ProjectEntryKind,
});
export type ProjectLocalSearchEntry = typeof ProjectLocalSearchEntry.Type;

export const ProjectSearchLocalEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectLocalSearchEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchLocalEntriesResult = typeof ProjectSearchLocalEntriesResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String.check(Schema.isMaxLength(PROJECT_READ_FILE_MAX_BYTES)),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
  previewGrant: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  maxBytes: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_READ_FILE_MAX_BYTES)),
  ),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectCreateLocalFilePreviewGrantInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectCreateLocalFilePreviewGrantInput =
  typeof ProjectCreateLocalFilePreviewGrantInput.Type;

export const ProjectCreateLocalFilePreviewGrantResult = Schema.Struct({
  grant: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type ProjectCreateLocalFilePreviewGrantResult =
  typeof ProjectCreateLocalFilePreviewGrantResult.Type;
// ── Dev Server Process Manager ───────────────────────────────────────
//
// Dev servers are first-class background processes owned by the server and
// keyed by project id, fully decoupled from chat threads. The server tracks
// their lifecycle and broadcasts changes over the `project.devServerEvent`
// push channel so every client stays in sync across reconnects.

export const ProjectDevServerStatus = Schema.Literals(["starting", "running"]);
export type ProjectDevServerStatus = typeof ProjectDevServerStatus.Type;

export const ProjectDevServer = Schema.Struct({
  projectId: ProjectId,
  command: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  pid: Schema.NullOr(PositiveInt),
  startedAt: TrimmedNonEmptyString,
  status: ProjectDevServerStatus,
});
export type ProjectDevServer = typeof ProjectDevServer.Type;

export const ProjectRunDevServerInput = Schema.Struct({
  projectId: ProjectId,
  command: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  env: Schema.optional(ProcessEnvRecord),
});
export type ProjectRunDevServerInput = typeof ProjectRunDevServerInput.Type;

export const ProjectRunDevServerResult = Schema.Struct({
  server: ProjectDevServer,
});
export type ProjectRunDevServerResult = typeof ProjectRunDevServerResult.Type;

export const ProjectStopDevServerInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectStopDevServerInput = typeof ProjectStopDevServerInput.Type;

export const ProjectStopDevServerResult = Schema.Struct({
  stopped: Schema.Boolean,
});
export type ProjectStopDevServerResult = typeof ProjectStopDevServerResult.Type;

export const ProjectListDevServersResult = Schema.Struct({
  servers: Schema.Array(ProjectDevServer),
});
export type ProjectListDevServersResult = typeof ProjectListDevServersResult.Type;

export const ProjectDevServerRemovedReason = Schema.Literals(["stopped", "exited"]);
export type ProjectDevServerRemovedReason = typeof ProjectDevServerRemovedReason.Type;

export const ProjectDevServerEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    servers: Schema.Array(ProjectDevServer),
  }),
  Schema.Struct({
    type: Schema.Literal("upserted"),
    server: ProjectDevServer,
  }),
  Schema.Struct({
    type: Schema.Literal("removed"),
    projectId: ProjectId,
    reason: ProjectDevServerRemovedReason,
  }),
]);
export type ProjectDevServerEvent = typeof ProjectDevServerEvent.Type;
