// FILE: threadBootstrap.ts
// Purpose: Pure helpers for draft reuse and terminal-thread promotion payloads.
// Layer: Web bootstrap/domain helpers
// Exports: draft patching, reuse checks, and terminal creation state resolution.

import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type OrchestrationThreadPullRequest,
  type ProjectId,
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
  type ThreadEnvironmentMode,
  type ThreadId,
} from "@synara/contracts";
import { resolveThreadEnvironmentMode } from "@synara/shared/threadEnvironment";
import {
  type ComposerThreadDraftState,
  type DraftThreadEnvMode,
  type DraftThreadState,
  resolvePreferredComposerModelSelection,
} from "../composerDraftStore";
import { DEFAULT_INTERACTION_MODE, type Thread, type ThreadPrimarySurface } from "../types";

export interface NewThreadOptions {
  branch?: string | null;
  worktreePath?: string | null;
  workingDirectory?: string | null;
  envMode?: DraftThreadEnvMode;
  entryPoint?: ThreadPrimarySurface;
  temporary?: boolean;
  provider?: ProviderKind;
  fresh?: boolean;
}

export interface InheritedThreadContext {
  branch: string | null;
  worktreePath: string | null;
  workingDirectory: string | null;
  envMode: DraftThreadEnvMode;
}

// Carry the active surface's branch/worktree/env into a new thread bootstrap.
// A pending draft wins outright; otherwise we derive the env mode from the
// active thread's worktree so a fresh thread inherits the same workspace shape.
export function resolveInheritedThreadContext(input: {
  activeThread:
    | Pick<Thread, "branch" | "worktreePath" | "workingDirectory" | "envMode">
    | null
    | undefined;
  activeDraftThread:
    | Pick<DraftThreadState, "branch" | "worktreePath" | "workingDirectory" | "envMode">
    | null
    | undefined;
}): InheritedThreadContext {
  const { activeThread, activeDraftThread } = input;
  if (activeDraftThread) {
    return {
      branch: activeDraftThread.branch,
      worktreePath: activeDraftThread.worktreePath,
      workingDirectory: activeDraftThread.workingDirectory ?? null,
      envMode: activeDraftThread.envMode,
    };
  }
  return {
    branch: activeThread?.branch ?? null,
    worktreePath: activeThread?.worktreePath ?? null,
    workingDirectory: activeThread?.workingDirectory ?? null,
    envMode: resolveThreadEnvironmentMode({
      envMode: activeThread?.envMode,
      worktreePath: activeThread?.worktreePath ?? null,
    }),
  };
}

interface ActiveThreadSnapshot {
  projectId: ProjectId;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode?: ThreadEnvironmentMode | undefined;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
}

export interface DraftReusePlanStored {
  draftThread: DraftThreadState;
  kind: "stored";
  threadId: ThreadId;
}

export interface DraftReusePlanRoute {
  draftThread: DraftThreadState;
  kind: "route";
  threadId: ThreadId;
}

export interface DraftReusePlanFresh {
  kind: "fresh";
}

export type ThreadBootstrapPlan = DraftReusePlanStored | DraftReusePlanRoute | DraftReusePlanFresh;

interface ResolveTerminalThreadCreationStateInput {
  activeDraftThread: DraftThreadState | null;
  activeThread: ActiveThreadSnapshot | null;
  defaultProvider?: ProviderKind | null | undefined;
  draftComposerState: ComposerThreadDraftState | null;
  draftThread: DraftThreadState | null;
  options: NewThreadOptions | undefined;
  projectDefaultModelSelection: ModelSelection | null;
  projectId: ProjectId;
}

export interface TerminalThreadCreationState {
  branch: string | null;
  envMode: DraftThreadEnvMode;
  interactionMode: ProviderInteractionMode;
  lastKnownPr: OrchestrationThreadPullRequest | null;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  worktreePath: string | null;
  workingDirectory: string | null;
}

// Normalize the currently active server thread into a stable snapshot for pure helpers.
export function createActiveThreadSnapshot(
  activeThread:
    | {
        interactionMode: ProviderInteractionMode;
        modelSelection: ModelSelection;
        projectId: ProjectId;
        runtimeMode: RuntimeMode;
        envMode?: ThreadEnvironmentMode | undefined;
        lastKnownPr?: OrchestrationThreadPullRequest | null;
      }
    | null
    | undefined,
  projectId: ProjectId,
): ActiveThreadSnapshot | null {
  if (!activeThread || activeThread.projectId !== projectId) {
    return null;
  }
  return {
    projectId: activeThread.projectId,
    modelSelection: activeThread.modelSelection,
    runtimeMode: activeThread.runtimeMode,
    interactionMode: activeThread.interactionMode,
    envMode: activeThread.envMode,
    lastKnownPr: activeThread.lastKnownPr ?? null,
  };
}

// Normalize the currently active draft thread into a stable snapshot for pure helpers.
export function createActiveDraftThreadSnapshot(
  activeDraftThread: DraftThreadState | null | undefined,
  projectId: ProjectId,
): DraftThreadState | null {
  if (!activeDraftThread || activeDraftThread.projectId !== projectId) {
    return null;
  }
  return {
    projectId: activeDraftThread.projectId,
    createdAt: activeDraftThread.createdAt,
    runtimeMode: activeDraftThread.runtimeMode,
    interactionMode: activeDraftThread.interactionMode,
    entryPoint: activeDraftThread.entryPoint,
    branch: activeDraftThread.branch,
    worktreePath: activeDraftThread.worktreePath,
    workingDirectory: activeDraftThread.workingDirectory ?? null,
    lastKnownPr: activeDraftThread.lastKnownPr ?? null,
    envMode: activeDraftThread.envMode,
    ...(activeDraftThread.isTemporary ? { isTemporary: true } : {}),
  };
}

// Decide whether we should reuse a stored draft, the current route draft, or create a fresh one.
export function resolveThreadBootstrapPlan(input: {
  entryPoint: ThreadPrimarySurface;
  latestActiveDraftThread: DraftThreadState | null;
  projectId: ProjectId;
  routeThreadId: ThreadId | null;
  storedDraftThread: ({ threadId: ThreadId } & DraftThreadState) | null;
}): ThreadBootstrapPlan {
  if (
    shouldReuseActiveDraftThread({
      draftThread: input.latestActiveDraftThread,
      entryPoint: input.entryPoint,
      projectId: input.projectId,
      routeThreadId: input.routeThreadId,
    })
  ) {
    return {
      kind: "route",
      threadId: input.routeThreadId!,
      draftThread: input.latestActiveDraftThread!,
    };
  }
  if (input.storedDraftThread) {
    return {
      kind: "stored",
      threadId: input.storedDraftThread.threadId,
      draftThread: input.storedDraftThread,
    };
  }
  return { kind: "fresh" };
}

// Build the initial draft-thread metadata for a brand new thread bootstrap.
export function createFreshDraftThreadSeed(input: {
  createdAt: string;
  entryPoint: ThreadPrimarySurface;
  options: NewThreadOptions | undefined;
}): Omit<DraftThreadState, "projectId" | "interactionMode"> {
  return {
    createdAt: input.createdAt,
    branch: input.options?.branch ?? null,
    worktreePath: input.options?.worktreePath ?? null,
    workingDirectory: input.options?.workingDirectory ?? null,
    envMode: input.options?.envMode ?? "local",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    entryPoint: input.entryPoint,
    ...(input.options?.temporary ? { isTemporary: true } : {}),
  };
}

// Detect whether the caller wants to override stored draft context before reuse.
export function hasDraftContextOverrides(options?: NewThreadOptions): boolean {
  return (
    options?.branch !== undefined ||
    options?.worktreePath !== undefined ||
    options?.workingDirectory !== undefined ||
    options?.envMode !== undefined
  );
}

// Build the exact patch we should apply to an existing draft before reusing it.
export function buildDraftThreadContextPatch(
  entryPoint: ThreadPrimarySurface,
  options?: NewThreadOptions,
): {
  branch?: string | null;
  entryPoint: ThreadPrimarySurface;
  envMode?: DraftThreadEnvMode;
  worktreePath?: string | null;
  workingDirectory?: string | null;
} | null {
  if (!hasDraftContextOverrides(options)) {
    return null;
  }
  const shouldClearWorktreeForLocalMode =
    options?.envMode === "local" && options?.worktreePath === undefined;
  return {
    ...(options?.branch !== undefined ? { branch: options.branch ?? null } : {}),
    ...(options?.worktreePath !== undefined || shouldClearWorktreeForLocalMode
      ? { worktreePath: options?.worktreePath ?? null }
      : {}),
    ...(options?.workingDirectory !== undefined
      ? { workingDirectory: options.workingDirectory ?? null }
      : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    entryPoint,
  };
}

// Reuse only when the active route draft already belongs to the target project and surface.
export function shouldReuseActiveDraftThread(input: {
  draftThread: DraftThreadState | null;
  entryPoint: ThreadPrimarySurface;
  projectId: ProjectId;
  routeThreadId: ThreadId | null;
}): input is {
  draftThread: DraftThreadState;
  entryPoint: ThreadPrimarySurface;
  projectId: ProjectId;
  routeThreadId: ThreadId;
} {
  return Boolean(
    input.draftThread &&
    input.routeThreadId &&
    input.draftThread.projectId === input.projectId &&
    input.draftThread.entryPoint === input.entryPoint,
  );
}

// Resolve the durable thread payload for terminal-first promotion from the most specific state.
export function resolveTerminalThreadCreationState(
  input: ResolveTerminalThreadCreationStateInput,
): TerminalThreadCreationState {
  const hasExplicitEnvModeOverride =
    input.options !== undefined && Object.hasOwn(input.options, "envMode");
  const explicitEnvMode: DraftThreadEnvMode | undefined = hasExplicitEnvModeOverride
    ? (input.options?.envMode ?? "local")
    : undefined;
  const inheritedEnvMode =
    input.draftThread?.envMode !== undefined
      ? input.draftThread.envMode
      : input.activeThread?.projectId === input.projectId
        ? input.activeThread.envMode
        : input.activeDraftThread?.projectId === input.projectId
          ? input.activeDraftThread.envMode
          : undefined;

  return {
    modelSelection: resolvePreferredComposerModelSelection({
      draft: input.draftComposerState,
      threadModelSelection:
        input.activeThread?.projectId === input.projectId
          ? input.activeThread.modelSelection
          : null,
      projectModelSelection: input.projectDefaultModelSelection,
      defaultProvider: input.defaultProvider,
    }),
    runtimeMode:
      input.draftThread?.runtimeMode ??
      (input.activeThread?.projectId === input.projectId ? input.activeThread.runtimeMode : null) ??
      (input.activeDraftThread?.projectId === input.projectId
        ? input.activeDraftThread.runtimeMode
        : null) ??
      DEFAULT_RUNTIME_MODE,
    interactionMode:
      // Plan mode is an explicit composer/thread choice. Do not copy it from
      // the previously active thread into a fresh session bootstrap.
      input.draftThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    lastKnownPr:
      input.draftThread?.lastKnownPr ??
      (input.activeThread?.projectId === input.projectId
        ? (input.activeThread.lastKnownPr ?? null)
        : null) ??
      (input.activeDraftThread?.projectId === input.projectId
        ? (input.activeDraftThread.lastKnownPr ?? null)
        : null) ??
      null,
    envMode: hasExplicitEnvModeOverride
      ? (explicitEnvMode ?? "local")
      : (inheritedEnvMode ?? "local"),
    branch:
      input.options?.branch !== undefined
        ? (input.options.branch ?? null)
        : (input.draftThread?.branch ?? null),
    worktreePath: (() => {
      if (input.options?.worktreePath !== undefined) {
        return input.options.worktreePath ?? null;
      }
      if (explicitEnvMode === "local") {
        return null;
      }
      return input.draftThread?.worktreePath ?? null;
    })(),
    workingDirectory:
      input.options?.workingDirectory !== undefined
        ? (input.options.workingDirectory ?? null)
        : (input.draftThread?.workingDirectory ?? null),
  };
}
