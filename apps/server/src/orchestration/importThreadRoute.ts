// FILE: importThreadRoute.ts
// Purpose: Imports provider-native sessions and binds them to Synara thread projections.
// Layer: Orchestration command handler
// Exports: makeImportThreadHandler.

import {
  CommandId,
  type OrchestrationImportThreadInput,
  type ProviderKind,
  type ThreadHandoffImportedMessage,
  type ThreadId,
} from "@synara/contracts";
import {
  deriveAssociatedWorktreeMetadata,
  workspaceRootsEqual,
} from "@synara/shared/threadWorkspace";
import type { FileSystem, Path } from "effect";
import { Data, Effect, Option } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils";
import { loadClaudeAgentSdk } from "../provider/claudeAgentSdk.ts";
import { ensureProviderEnabled } from "../provider/enabledProviderAdapter";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ServerSettingsShape } from "../serverSettings";
import { parseManagedWorktreeWorkspaceRoot } from "../workspace/managedWorktree";
import {
  mapClaudeSessionMessages,
  mapCodexSnapshotMessages,
  mapFactorySnapshotMessages,
  mapOpenCodeSnapshotMessages,
} from "./importedThreadMessages";

type ImportThreadRequest = OrchestrationImportThreadInput;

class ImportThreadError extends Data.TaggedError("ImportThreadError")<{
  readonly message: string;
}> {}

function importMessagesError(message: string): ImportThreadError {
  return new ImportThreadError({ message });
}

function providerResumeCursorForImport(provider: ProviderKind, externalId: string): unknown {
  switch (provider) {
    case "claudeAgent":
      return { resume: externalId };
    case "droid":
      return { schemaVersion: 1, sessionId: externalId };
    case "kilo":
    case "opencode":
      return { openCodeSessionId: externalId };
    default:
      return { threadId: externalId };
  }
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): "starting" | "ready" | "running" | "error" | "stopped" {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

export interface ImportThreadHandlerOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerAdapterRegistry: ProviderAdapterRegistryShape;
  readonly providerService: ProviderServiceShape;
  readonly serverSettings: ServerSettingsShape;
}

export function makeImportThreadHandler(options: ImportThreadHandlerOptions) {
  const dispatchImportedMessages = (input: {
    readonly createdAt: string;
    readonly messages: ReadonlyArray<ThreadHandoffImportedMessage>;
    readonly threadId: ThreadId;
  }) =>
    input.messages.length === 0
      ? Effect.void
      : options.orchestrationEngine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: input.threadId,
          messages: input.messages,
          createdAt: input.createdAt,
        });

  const ensureClaudeThreadImportable = Effect.fn(function* (input: {
    readonly cwd: string | undefined;
    readonly externalId: string;
  }) {
    const claudeSessionInfo = yield* Effect.tryPromise({
      try: async () => {
        const { getSessionInfo } = await loadClaudeAgentSdk();
        return getSessionInfo(input.externalId, input.cwd ? { dir: input.cwd } : undefined);
      },
      catch: (cause) =>
        importMessagesError(
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "Failed to inspect Claude session metadata.",
        ),
    });

    if (claudeSessionInfo) return;

    const sessionFoundElsewhere = yield* Effect.tryPromise({
      try: async () => {
        const { getSessionInfo } = await loadClaudeAgentSdk();
        return getSessionInfo(input.externalId);
      },
      catch: () => undefined,
    });

    return yield* Effect.fail(
      importMessagesError(
        sessionFoundElsewhere && input.cwd
          ? `Claude session '${input.externalId}' exists, but not for this workspace. Claude resume only works when the session file is stored for '${input.cwd}'.`
          : `Claude session '${input.externalId}' was not found on this machine for this workspace. Claude import only works with a locally persisted Claude session ID.`,
      ),
    );
  });

  const resolveImportedProviderThreadContext = Effect.fn(function* (input: {
    readonly provider: "codex" | "droid" | "kilo" | "opencode";
    readonly externalId: string;
    readonly projectWorkspaceRoot: string;
    readonly fallbackCwd?: string;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider(input.provider);
    if (!adapter.readExternalThread) return null;

    const snapshot = yield* adapter
      .readExternalThread({
        externalThreadId: input.externalId,
        ...(input.fallbackCwd ? { cwd: input.fallbackCwd } : {}),
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const externalCwd = snapshot?.cwd?.trim();
    if (!externalCwd) return null;

    if (
      workspaceRootsEqual(input.projectWorkspaceRoot, externalCwd, {
        platform: options.platform,
      })
    ) {
      return {
        runtimeCwd: externalCwd,
        patch: {
          envMode: "local" as const,
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
        },
      };
    }

    const relativeToProjectRoot = options.path.relative(input.projectWorkspaceRoot, externalCwd);
    if (
      relativeToProjectRoot.length > 0 &&
      !relativeToProjectRoot.startsWith("..") &&
      !options.path.isAbsolute(relativeToProjectRoot)
    ) {
      return {
        runtimeCwd: externalCwd,
        patch: null,
      };
    }

    let currentPath = externalCwd;
    while (true) {
      const gitPointerFileContents = yield* options.fileSystem
        .readFileString(options.path.join(currentPath, ".git"))
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (gitPointerFileContents) {
        const workspaceRoot = parseManagedWorktreeWorkspaceRoot({
          gitPointerFileContents,
          path: options.path,
          worktreePath: currentPath,
        });
        if (
          workspaceRoot &&
          workspaceRootsEqual(input.projectWorkspaceRoot, workspaceRoot, {
            platform: options.platform,
          })
        ) {
          return {
            runtimeCwd: externalCwd,
            patch: {
              envMode: "worktree" as const,
              branch: null,
              worktreePath: currentPath,
              ...deriveAssociatedWorktreeMetadata({
                branch: null,
                worktreePath: currentPath,
              }),
            },
          };
        }
      }

      const parentPath = options.path.dirname(currentPath);
      if (parentPath === currentPath) return null;
      currentPath = parentPath;
    }
  });

  const importCodexThreadHistory = Effect.fn(function* (input: {
    readonly importedAt: string;
    readonly threadId: ThreadId;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider("codex");
    const snapshot = yield* adapter
      .readThread(input.threadId)
      .pipe(
        Effect.mapError((cause) =>
          importMessagesError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "Failed to read Codex thread history.",
          ),
        ),
      );

    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: mapCodexSnapshotMessages({
        threadId: input.threadId,
        turns: snapshot.turns,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  const importClaudeThreadHistory = Effect.fn(function* (input: {
    readonly cwd: string | undefined;
    readonly externalId: string;
    readonly importedAt: string;
    readonly threadId: ThreadId;
  }) {
    const sessionMessages = yield* Effect.tryPromise({
      try: async () => {
        const { getSessionMessages } = await loadClaudeAgentSdk();
        return getSessionMessages(input.externalId, input.cwd ? { dir: input.cwd } : undefined);
      },
      catch: (cause) =>
        importMessagesError(
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "Failed to read Claude session history.",
        ),
    });

    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: mapClaudeSessionMessages({
        threadId: input.threadId,
        messages: sessionMessages,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  const importOpenCodeCompatibleThreadHistory = Effect.fn(function* (input: {
    readonly importedAt: string;
    readonly provider: "kilo" | "opencode";
    readonly threadId: ThreadId;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider(input.provider);
    const snapshot = yield* adapter
      .readThread(input.threadId)
      .pipe(
        Effect.mapError((cause) =>
          importMessagesError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : `Failed to read ${input.provider === "kilo" ? "Kilo" : "OpenCode"} session history.`,
          ),
        ),
      );

    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: mapOpenCodeSnapshotMessages({
        threadId: input.threadId,
        turns: snapshot.turns,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  const importDroidThreadHistory = Effect.fn(function* (input: {
    readonly externalId: string;
    readonly importedAt: string;
    readonly threadId: ThreadId;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider("droid");
    if (!adapter.readExternalThread) {
      return yield* Effect.fail(importMessagesError("Droid session import is unavailable."));
    }
    const snapshot = yield* adapter
      .readExternalThread({ externalThreadId: input.externalId })
      .pipe(
        Effect.mapError((cause) =>
          importMessagesError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "Failed to read Droid session history.",
          ),
        ),
      );
    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: mapFactorySnapshotMessages({
        threadId: input.threadId,
        turns: snapshot.turns,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  return Effect.fnUntraced(function* (body: ImportThreadRequest) {
    const threadOption = yield* options.projectionSnapshotQuery.getThreadDetailById(body.threadId);
    if (Option.isNone(threadOption)) {
      return yield* Effect.fail(importMessagesError(`Thread '${body.threadId}' was not found.`));
    }
    const thread = threadOption.value;

    if (thread.session && thread.session.status !== "stopped") {
      return yield* Effect.fail(
        importMessagesError(`Thread '${body.threadId}' already has an active provider session.`),
      );
    }

    yield* ensureProviderEnabled(thread.modelSelection.provider, options.serverSettings);

    const projectOption = yield* options.projectionSnapshotQuery.getProjectShellById(
      thread.projectId,
    );
    const project = Option.getOrNull(projectOption);
    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project
        ? [
            {
              id: project.id,
              kind: project.kind,
              workspaceRoot: project.workspaceRoot,
            },
          ]
        : [],
    });
    const externalId = body.externalId.trim();

    const importedProviderContext =
      (thread.modelSelection.provider === "codex" ||
        thread.modelSelection.provider === "droid" ||
        thread.modelSelection.provider === "kilo" ||
        thread.modelSelection.provider === "opencode") &&
      project
        ? yield* resolveImportedProviderThreadContext({
            provider: thread.modelSelection.provider,
            externalId,
            projectWorkspaceRoot: project.workspaceRoot,
            ...(cwd ? { fallbackCwd: cwd } : {}),
          })
        : null;

    if (importedProviderContext?.patch) {
      yield* options.orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: thread.id,
        ...importedProviderContext.patch,
      });
    }

    if (thread.modelSelection.provider === "claudeAgent") {
      yield* ensureClaudeThreadImportable({
        cwd,
        externalId,
      });
    }

    const importResumeCursor = providerResumeCursorForImport(
      thread.modelSelection.provider,
      externalId,
    );
    const session = yield* options.providerService.startSession(thread.id, {
      threadId: thread.id,
      provider: thread.modelSelection.provider,
      ...((importedProviderContext?.runtimeCwd ?? cwd)
        ? { cwd: importedProviderContext?.runtimeCwd ?? cwd }
        : {}),
      modelSelection: thread.modelSelection,
      ...(thread.modelSelection.provider === "codex"
        ? { forkSourceResumeCursor: importResumeCursor }
        : { resumeCursor: importResumeCursor }),
      runtimeMode: thread.runtimeMode,
    });

    yield* Effect.gen(function* () {
      if (thread.modelSelection.provider === "codex") {
        yield* importCodexThreadHistory({
          threadId: thread.id,
          importedAt: session.updatedAt,
        });
      } else if (thread.modelSelection.provider === "claudeAgent") {
        yield* importClaudeThreadHistory({
          threadId: thread.id,
          externalId,
          cwd,
          importedAt: session.updatedAt,
        });
      } else if (thread.modelSelection.provider === "droid") {
        yield* importDroidThreadHistory({
          threadId: thread.id,
          externalId,
          importedAt: session.updatedAt,
        });
      } else if (
        thread.modelSelection.provider === "kilo" ||
        thread.modelSelection.provider === "opencode"
      ) {
        yield* importOpenCodeCompatibleThreadHistory({
          provider: thread.modelSelection.provider,
          threadId: thread.id,
          importedAt: session.updatedAt,
        });
      }
    }).pipe(
      Effect.onError(() =>
        // Startup precedes history materialization. Roll it back when import
        // cannot finish so no provider child or persisted binding is orphaned.
        options.providerService.stopSession({ threadId: thread.id }).pipe(Effect.ignore),
      ),
    );

    yield* options.orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: mapProviderSessionStatusToOrchestrationStatus(session.status),
        providerName: session.provider,
        runtimeMode: thread.runtimeMode,
        activeTurnId: null,
        lastError: session.lastError ?? null,
        updatedAt: session.updatedAt,
      },
      createdAt: session.updatedAt,
    });

    return { threadId: thread.id };
  });
}
