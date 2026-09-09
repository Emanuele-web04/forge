// Purpose: Client dispatch helpers for opt-in automatic title refresh (#1041):
// accept/dismiss suggested candidates, pin management, and policy overrides.
// Layer: Web lib (native API dispatch only, no UI).

import type { ProjectId, ThreadId, ThreadTitleRefreshMode } from "@synara/contracts";

import { readNativeApi } from "../nativeApi";
import { newCommandId } from "./utils";

export async function acceptThreadTitleSuggestion(input: {
  threadId: ThreadId;
  title: string;
}): Promise<boolean> {
  const api = readNativeApi();
  if (!api) return false;
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId: input.threadId,
    title: input.title.trim(),
    pendingSuggestedTitle: null,
    manualTitlePinned: true,
  });
  return true;
}

export async function dismissThreadTitleSuggestion(threadId: ThreadId): Promise<boolean> {
  const api = readNativeApi();
  if (!api) return false;
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    pendingSuggestedTitle: null,
  });
  return true;
}

export async function setThreadManualTitlePin(
  threadId: ThreadId,
  pinned: boolean,
): Promise<boolean> {
  const api = readNativeApi();
  if (!api) return false;
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    manualTitlePinned: pinned,
  });
  return true;
}

export async function setThreadTitleRefreshMode(
  threadId: ThreadId,
  mode: ThreadTitleRefreshMode | null,
): Promise<boolean> {
  const api = readNativeApi();
  if (!api) return false;
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    titleRefreshMode: mode,
  });
  return true;
}

export async function setProjectTitleRefreshMode(
  projectId: ProjectId,
  mode: ThreadTitleRefreshMode | null,
): Promise<boolean> {
  const api = readNativeApi();
  if (!api) return false;
  await api.orchestration.dispatchCommand({
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId,
    titleRefreshMode: mode,
  });
  return true;
}
