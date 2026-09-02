import type { ProjectResolveWorkspaceFileReferencesResult } from "@synara/contracts";

import { ensureNativeApi } from "~/nativeApi";

const MAX_WORKSPACE_FILE_REFERENCE_BATCH_SIZE = 128;

type PendingWorkspaceFileReference = {
  readonly relativePath: string;
  readonly resolve: (relativePath: string | null) => void;
  readonly reject: (cause: unknown) => void;
};

const pendingByCwd = new Map<string, PendingWorkspaceFileReference[]>();
const scheduledCwds = new Set<string>();

async function requestWorkspaceFileReferenceChunks(
  cwd: string,
  uniquePaths: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string | null>> {
  const api = ensureNativeApi();
  const resolvedByPath = new Map<string, string | null>();
  for (
    let offset = 0;
    offset < uniquePaths.length;
    offset += MAX_WORKSPACE_FILE_REFERENCE_BATCH_SIZE
  ) {
    const relativePaths = uniquePaths.slice(
      offset,
      offset + MAX_WORKSPACE_FILE_REFERENCE_BATCH_SIZE,
    );
    const result: ProjectResolveWorkspaceFileReferencesResult =
      await api.projects.resolveWorkspaceFileReferences({ cwd, relativePaths });
    if (result.relativePaths.length !== relativePaths.length) {
      throw new Error("Workspace file reference response length did not match the request.");
    }
    relativePaths.forEach((relativePath, index) => {
      resolvedByPath.set(relativePath, result.relativePaths[index] ?? null);
    });
  }
  return resolvedByPath;
}

async function flushWorkspaceFileReferenceBatch(cwd: string): Promise<void> {
  scheduledCwds.delete(cwd);
  const pending = pendingByCwd.get(cwd) ?? [];
  pendingByCwd.delete(cwd);
  if (pending.length === 0) {
    return;
  }

  try {
    const uniquePaths = [...new Set(pending.map((entry) => entry.relativePath))];
    const resolvedByPath = await requestWorkspaceFileReferenceChunks(cwd, uniquePaths);
    pending.forEach((entry) => entry.resolve(resolvedByPath.get(entry.relativePath) ?? null));
  } catch (cause) {
    pending.forEach((entry) => entry.reject(cause));
  }
}

export function resolveWorkspaceFileReferenceBatched(input: {
  cwd: string;
  relativePath: string;
}): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const pending = pendingByCwd.get(input.cwd);
    const entry = { relativePath: input.relativePath, resolve, reject };
    if (pending) {
      pending.push(entry);
    } else {
      pendingByCwd.set(input.cwd, [entry]);
    }
    if (!scheduledCwds.has(input.cwd)) {
      scheduledCwds.add(input.cwd);
      queueMicrotask(() => void flushWorkspaceFileReferenceBatch(input.cwd));
    }
  });
}
