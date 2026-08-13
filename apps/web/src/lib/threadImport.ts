import type {
  ModelSelection,
  NativeApi,
  ProjectId,
  ProviderKind,
  ThreadEnvironmentMode,
  ThreadId,
} from "@synara/contracts";

import { newCommandId, newThreadId } from "./utils";

export type ImportProviderKind = Extract<
  ProviderKind,
  "codex" | "claudeAgent" | "cursor" | "kilo" | "opencode"
>;

const IMPORTED_TITLE_PREFIX_BY_PROVIDER: Record<ImportProviderKind, string> = {
  claudeAgent: "Imported Claude session",
  cursor: "Imported Cursor session",
  kilo: "Imported Kilo session",
  opencode: "Imported OpenCode session",
  codex: "Imported Codex thread",
};

export function importedThreadTitle(input: {
  provider: ImportProviderKind;
  externalId: string;
  title?: string | undefined;
}): string {
  const providedTitle = input.title?.trim();
  if (providedTitle) {
    return providedTitle;
  }
  const suffix = input.externalId.trim().slice(-8);
  const prefix = IMPORTED_TITLE_PREFIX_BY_PROVIDER[input.provider];
  return suffix ? `${prefix} ${suffix}` : prefix;
}

export async function importExternalThread(input: {
  api: NativeApi;
  projectId: ProjectId;
  provider: ImportProviderKind;
  externalId: string;
  modelSelection: ModelSelection;
  envMode: ThreadEnvironmentMode;
  title?: string | undefined;
}): Promise<ThreadId> {
  const threadId = newThreadId();
  const createdAt = new Date().toISOString();
  const trimmedExternalId = input.externalId.trim();
  let createdThread = false;

  try {
    await input.api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: input.projectId,
      title: importedThreadTitle({
        provider: input.provider,
        externalId: trimmedExternalId,
        title: input.title,
      }),
      modelSelection: input.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: input.envMode,
      branch: null,
      worktreePath: null,
      createdAt,
    });
    createdThread = true;

    await input.api.orchestration.importThread({
      threadId,
      externalId: trimmedExternalId,
    });

    return threadId;
  } catch (error) {
    if (createdThread) {
      await input.api.orchestration
        .dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId,
        })
        .catch(() => undefined);
    }
    throw error;
  }
}
