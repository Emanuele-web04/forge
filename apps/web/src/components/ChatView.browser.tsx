// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  AutomationId,
  type AutomationCreateInput,
  type AutomationDefinition,
  CheckpointRef,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  SpaceId,
  ThreadId,
  TurnId,
  type WsWelcomePayload,
  WS_METHODS,
  OrchestrationSessionStatus,
} from "@synara/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page, userEvent } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollContainerDistanceFromBottom,
} from "../chat-scroll";
import { useLatestProjectStore } from "../latestProjectStore";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
  removeInlineTerminalContextPlaceholder,
} from "../lib/terminalContext";
import { extractTrailingBrowserAnnotations } from "../lib/browserAnnotations";
import { isMacPlatform } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { resetHomeChatProjectPrewarmStateForTests } from "../lib/chatProjects";
import { resetStudioProjectPrewarmStateForTests } from "../lib/studioProjects";
import { getRouter } from "../router";
import { useSplitViewStore } from "../splitViewStore";
import { useSpacesUiStore } from "../spacesUiStore";
import { useStore } from "../store";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "../test/effectRpcWebSocketMock";
import { createBrowserTestServerConfig, createFullscreenTestHost } from "../test/browserHarness";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { resetRetainedThreadDetailSubscriptionsForTests } from "../threadDetailSubscriptionRetention";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { resetWsNativeApiForTest } from "../wsNativeApi";
// Pre-transform the compiler-heavy component outside the first case's timeout.
// The router's auto-split route otherwise requests this module on first mount.
import "./ChatView";
import { estimateTimelineMessageHeight } from "./timelineHeight";

const THREAD_ID = "thread-browser-test" as ThreadId;
const OTHER_THREAD_ID = "thread-browser-test-other" as ThreadId;
const THREAD_TITLE = "Browser test thread";
const UUID_ROUTE_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = "project-1" as ProjectId;
const OTHER_PROJECT_ID = "project-2" as ProjectId;
const HOME_PROJECT_ID = "project-home" as ProjectId;
const STUDIO_PROJECT_ID = "project-studio" as ProjectId;
const STUDIO_DRAFT_THREAD_ID = "thread-studio-draft" as ThreadId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";
let attachmentResponseDelayMs = 0;
let attachmentUploadSequence = 0;

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
  gitBranchByCwd: Record<string, string>;
}

let fixture: TestFixture;
const wsRequests: WsRequestEnvelope["body"][] = [];
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  textTolerancePx: number;
  attachmentTolerancePx: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const TEXT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "tablet", width: 720, height: 1_024, textTolerancePx: 44, attachmentTolerancePx: 56 },
  { name: "mobile", width: 430, height: 932, textTolerancePx: 56, attachmentTolerancePx: 56 },
  { name: "narrow", width: 320, height: 700, textTolerancePx: 84, attachmentTolerancePx: 56 },
] as const satisfies readonly ViewportSpec[];
const ATTACHMENT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "mobile", width: 430, height: 932, textTolerancePx: 56, attachmentTolerancePx: 56 },
  { name: "narrow", width: 320, height: 700, textTolerancePx: 84, attachmentTolerancePx: 56 },
] as const satisfies readonly ViewportSpec[];

interface UserRowMeasurement {
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
  renderedInVirtualizedRegion: boolean;
}

interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  measureLayout: () => Promise<ChatLayoutMeasurement>;
  measureUserRow: (targetMessageId: MessageId) => Promise<UserRowMeasurement>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

interface ChatLayoutMeasurement {
  hostHeightPx: number;
  composerBottomPx: number;
  scrollClientHeightPx: number;
  scrollHeightPx: number;
  distanceFromBottomPx: number;
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return createBrowserTestServerConfig(NOW_ISO);
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: { id: MessageId; text: string; offsetSeconds: number }) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

function createComposerImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "queued-image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 8;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified: BASE_TIME_MS,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: 1,
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: THREAD_TITLE,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId:
            options.sessionStatus === "running"
              ? TurnId.makeUnsafe("turn-browser-fixture-active")
              : null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function createSnapshotWithLongAssistantResponse(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-assistant-overflow-target" as MessageId,
    targetText: "start",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  const messageIndex = messages.findIndex(
    (message, index) => message.role === "assistant" && index === 7,
  );
  if (messageIndex < 0) {
    return snapshot;
  }

  const message = messages[messageIndex]!;
  messages[messageIndex] = {
    ...message,
    text: Array.from(
      { length: 240 },
      (_, lineIndex) =>
        `${lineIndex + 1}. keep the viewport stable while this response keeps growing`,
    ).join("\n"),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

function createSnapshotWithBottomAttachments(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-bottom-attachments" as MessageId,
    targetText: "bottom attachments",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }
  if (lastUserMessageIndex < 0) {
    return snapshot;
  }

  const lastUserMessage = messages[lastUserMessageIndex]!;
  messages[lastUserMessageIndex] = {
    ...lastUserMessage,
    text: "final user message with delayed attachments",
    attachments: Array.from({ length: 3 }, (_, attachmentIndex) => ({
      type: "image" as const,
      id: `bottom-attachment-${attachmentIndex + 1}`,
      name: `bottom-attachment-${attachmentIndex + 1}.png`,
      mimeType: "image/png",
      sizeBytes: 128,
    })),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    gitBranchByCwd: {},
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function findThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] | null {
  return fixture.snapshot.threads.find((entry) => entry.id === threadId) ?? null;
}

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function createAutomationDefinitionFromCreateRequest(
  body: WsRequestEnvelope["body"],
): AutomationDefinition {
  const input = body as unknown as AutomationCreateInput;
  const definition: AutomationDefinition = {
    id: AutomationId.makeUnsafe(`automation-${wsRequests.length}`),
    projectId: input.projectId,
    sourceThreadId: input.sourceThreadId ?? null,
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    enabled: input.enabled ?? true,
    nextRunAt: null,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: input.interactionMode ?? "default",
    worktreeMode: input.worktreeMode ?? "auto",
    mode: input.mode ?? "standalone",
    targetThreadId: input.targetThreadId ?? null,
    maxIterations: input.maxIterations ?? null,
    stopOnError: input.stopOnError ?? true,
    completionPolicy: input.completionPolicy ?? { type: "none" },
    completionPolicyVersion: 1,
    completionPolicyUpdatedAt: NOW_ISO,
    minimumIntervalSeconds: input.minimumIntervalSeconds ?? 60,
    maxRuntimeSeconds: input.maxRuntimeSeconds ?? 3_600,
    retryPolicy: input.retryPolicy ?? { type: "none" },
    misfirePolicy: input.misfirePolicy ?? "coalesce",
    acknowledgedRisks: input.acknowledgedRisks ?? [],
    iterationCount: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
  };
  return input.providerOptions === undefined
    ? definition
    : { ...definition, providerOptions: input.providerOptions };
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function withOpenProjectPickerFixtures(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: OTHER_PROJECT_ID,
        kind: "project",
        title: "Other Project",
        workspaceRoot: "/repo/other",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withHomeChatProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: HOME_PROJECT_ID,
        kind: "chat",
        title: "Home",
        workspaceRoot: "/Users/tester",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withActiveHomeChatThread(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  const snapshotWithHomeProject = withHomeChatProject(snapshot);
  return {
    ...snapshotWithHomeProject,
    threads: snapshotWithHomeProject.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, projectId: HOME_PROJECT_ID } : thread,
    ),
  };
}

function withStudioProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: STUDIO_PROJECT_ID,
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/Users/tester/Documents/Synara/Studio",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

function createSnapshotWithActiveInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-plan-target" as MessageId,
    targetText: "inline plan thread",
    sessionStatus: "running",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "running",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: null,
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.makeUnsafe("activity-inline-plan"),
                createdAt: isoAt(1_002),
                kind: "turn.tasks.updated",
                summary: "Tasks updated",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  tasks: [
                    {
                      task: "Inspecting ChatView boundaries",
                      status: "inProgress",
                    },
                    {
                      task: "Patch the shared checklist receiver",
                      status: "pending",
                    },
                    {
                      task: "Run final validation",
                      status: "completed",
                    },
                  ],
                },
              },
              {
                id: EventId.makeUnsafe("activity-inline-background-task"),
                createdAt: isoAt(1_003),
                kind: "task.started",
                summary: "Background agent started",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  taskId: "task-inline-background-agent",
                  taskType: "subagent",
                },
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "running",
                  activeTurnId,
                  updatedAt: isoAt(1_003),
                }
              : null,
            updatedAt: isoAt(1_003),
          }
        : thread,
    ),
  };
}

function createSnapshotWithTallComposerStack(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            checkpoints: [
              {
                turnId: activeTurnId,
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.makeUnsafe("checkpoint-inline-plan"),
                status: "ready",
                files: [
                  {
                    path: "apps/web/src/components/ChatView.tsx",
                    kind: "modified",
                    additions: 12,
                    deletions: 4,
                  },
                  {
                    path: "apps/web/src/components/ChatView.browser.tsx",
                    kind: "modified",
                    additions: 36,
                    deletions: 0,
                  },
                ],
                assistantMessageId: null,
                completedAt: isoAt(1_004),
              },
            ],
          }
        : thread,
    ),
  };
}

function createSnapshotWithSettledInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_004),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
            },
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
                role: "assistant",
                text: "Finished the investigation.",
                createdAt: isoAt(1_004),
                updatedAt: isoAt(1_004),
                completedAt: isoAt(1_004),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "ready",
                  activeTurnId: null,
                  updatedAt: isoAt(1_004),
                }
              : null,
            updatedAt: isoAt(1_004),
          }
        : thread,
    ),
  };
}

function createSnapshotWithSettledCompletedInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotWithSettledInlinePlan();

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            activities: thread.activities.map((activity) =>
              activity.kind === "turn.tasks.updated"
                ? {
                    ...activity,
                    payload: {
                      tasks: [
                        { task: "Inspecting ChatView boundaries", status: "completed" },
                        { task: "Patch the shared checklist receiver", status: "completed" },
                        { task: "Run final validation", status: "completed" },
                      ],
                    },
                  }
                : activity,
            ),
          }
        : thread,
    ),
  };
}

// A plan-mode thread whose latest turn has settled and that still has an
// actionable (unimplemented) proposed plan. This is exactly the state where the
// live composer shows the plan-follow-up prompt, so it's the setup that used to
// misroute an auto-dispatched queued *chat* turn into the plan-follow-up path.
function createSnapshotWithSettledPlanAwaitingFollowUp(): OrchestrationReadModel {
  const snapshot = createSnapshotWithSettledInlinePlan();
  const planMarkdown = [
    "# Proposed plan",
    "",
    "- Step 1: capture the failing state",
    "- Step 2: apply the fix",
    "- Step 3: add regression coverage",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            interactionMode: "plan",
            hasActionableProposedPlan: true,
            proposedPlans: [
              {
                id: "plan-awaiting-follow-up",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_005),
                updatedAt: isoAt(1_005),
              },
            ],
            updatedAt: isoAt(1_005),
          }
        : thread,
    ),
  };
}

function createSnapshotWithInlineToolOverflow(options: {
  active: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-tools-target" as MessageId,
    targetText: "inline tools thread",
    sessionStatus: options.active ? "running" : "ready",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-tools");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: options.active ? "running" : "completed",
              requestedAt: isoAt(1_100),
              startedAt: isoAt(1_101),
              completedAt: options.active ? null : isoAt(1_108),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-tools"),
            },
            activities: Array.from({ length: 6 }, (_, index) => ({
              id: EventId.makeUnsafe(`activity-inline-tool-${index + 1}`),
              createdAt: isoAt(1_102 + index),
              kind: "tool.completed" as const,
              summary: `tool ${index + 1}`,
              tone: "tool" as const,
              turnId: activeTurnId,
              payload: {
                itemType: "dynamic_tool_call",
                toolName: `tool-${index + 1}`,
              },
            })),
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-tools"),
                role: "assistant",
                text: "Wrapped up the inline tool review.",
                createdAt: isoAt(1_109),
                updatedAt: isoAt(1_109),
                completedAt: options.active ? undefined : isoAt(1_109),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: options.active ? "running" : "ready",
                  activeTurnId: options.active ? activeTurnId : null,
                  updatedAt: options.active ? isoAt(1_107) : isoAt(1_108),
                }
              : null,
            updatedAt: options.active ? isoAt(1_107) : isoAt(1_109),
          }
        : thread,
    ),
  };
}

function recordProjectCreateCommand(command: unknown): boolean {
  if (
    !command ||
    typeof command !== "object" ||
    !("type" in command) ||
    command.type !== "project.create" ||
    !("projectId" in command) ||
    !("workspaceRoot" in command) ||
    !("title" in command)
  ) {
    return false;
  }

  const projectId = command.projectId as ProjectId;
  fixture = {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      projects: [
        ...fixture.snapshot.projects.filter((project) => project.id !== projectId),
        {
          id: projectId,
          kind:
            "kind" in command && (command.kind === "chat" || command.kind === "studio")
              ? command.kind
              : "project",
          title: String(command.title),
          workspaceRoot: String(command.workspaceRoot),
          defaultModelSelection:
            "defaultModelSelection" in command &&
            command.defaultModelSelection &&
            typeof command.defaultModelSelection === "object"
              ? (command.defaultModelSelection as OrchestrationReadModel["projects"][number]["defaultModelSelection"])
              : {
                  provider: "codex" as const,
                  model: "gpt-5",
                },
          scripts: [],
          createdAt:
            "createdAt" in command && typeof command.createdAt === "string"
              ? command.createdAt
              : NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      updatedAt: NOW_ISO,
    },
  };
  return true;
}

function resolveWsRpc(body: WsRequestEnvelope["body"]): unknown {
  const tag = body._tag;
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    if (recordProjectCreateCommand(body.command)) {
      return { sequence: fixture.snapshot.snapshotSequence };
    }
    return { sequence: fixture.snapshot.snapshotSequence + 1 };
  }
  if (tag === WS_METHODS.automationCreate) {
    return createAutomationDefinitionFromCreateRequest(body);
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.projectsListDevServers) {
    return { servers: [] };
  }
  if (tag === WS_METHODS.automationList) {
    return { definitions: [], runs: [] };
  }
  if (tag === WS_METHODS.gitListBranches) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: branchName,
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      branch: branchName,
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.gitCreateWorktree) {
    const requestedBranch =
      typeof body.newBranch === "string"
        ? body.newBranch
        : typeof body.branch === "string"
          ? body.branch
          : "main";
    return {
      worktree: {
        path: `/repo/.codex/worktrees/project/${requestedBranch.replaceAll("/", "-")}`,
        branch: requestedBranch,
      },
    };
  }
  if (tag === WS_METHODS.gitCreateDetachedWorktree) {
    return {
      worktree: {
        path: "/repo/.codex/worktrees/generated/synara",
        ref: "0123456789abcdef0123456789abcdef01234567",
        branch: null,
      },
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  if (tag === WS_METHODS.shellOpenInEditor || tag === WS_METHODS.terminalWrite) {
    return null;
  }
  return {};
}

function installDeterministicSendNativeApi(): () => void {
  const previousNativeApi = window.nativeApi;
  const wsNativeApi = readNativeApi();
  if (!wsNativeApi) {
    throw new Error("Expected browser native API fixture.");
  }

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...wsNativeApi,
      git: {
        ...wsNativeApi.git,
        createDetachedWorktree: async (
          input: Parameters<typeof wsNativeApi.git.createDetachedWorktree>[0],
        ) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.gitCreateDetachedWorktree,
            ...input,
          };
          wsRequests.push(request);
          return resolveWsRpc(request) as Awaited<
            ReturnType<typeof wsNativeApi.git.createDetachedWorktree>
          >;
        },
      },
      terminal: {
        ...wsNativeApi.terminal,
        open: async (input: Parameters<typeof wsNativeApi.terminal.open>[0]) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.terminalOpen,
            ...input,
          };
          wsRequests.push(request);
          return resolveWsRpc(request) as Awaited<ReturnType<typeof wsNativeApi.terminal.open>>;
        },
        write: async (input: Parameters<typeof wsNativeApi.terminal.write>[0]) => {
          wsRequests.push({
            _tag: WS_METHODS.terminalWrite,
            ...input,
          });
        },
      },
      orchestration: {
        ...wsNativeApi.orchestration,
        dispatchCommand: async (
          command: Parameters<typeof wsNativeApi.orchestration.dispatchCommand>[0],
        ) => {
          wsRequests.push({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            command,
          });
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        },
      },
    },
  });

  return () => {
    if (previousNativeApi) {
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

function toRecordedWsRequestBody(request: {
  readonly tag: string;
  readonly payload: unknown;
}): WsRequestEnvelope["body"] {
  if (request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return {
      _tag: request.tag,
      command: request.payload,
    };
  }
  return flattenEffectRpcRequestPayload(request.tag, request.payload);
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      const parsed = readEffectRpcClientMessage(client, rawData);
      if (parsed.kind !== "request") return;

      const requestBody = toRecordedWsRequestBody(parsed.request);
      const method = requestBody._tag;
      wsRequests.push(requestBody);

      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        const threadId = requestBody.threadId as ThreadId;
        const thread = findThreadDetailFromFixtureSnapshot(threadId);
        if (!thread) {
          return;
        }
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread,
          },
        });
        return;
      }
      if (
        method === WS_METHODS.subscribeServerProviderStatuses ||
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents
      ) {
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(requestBody));
    });
  }),
  http.post(`*${ATTACHMENT_UPLOAD_ROUTE_PATH}`, async ({ request }) => {
    const url = new URL(request.url);
    const bytes = await request.arrayBuffer();
    attachmentUploadSequence += 1;
    return HttpResponse.json(
      {
        type: url.searchParams.get("type") ?? "file",
        id: `att_v2_${String(attachmentUploadSequence).padStart(32, "0")}`,
        name: url.searchParams.get("name") ?? "attachment.bin",
        mimeType: url.searchParams.get("mimeType") ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
      },
      { status: 201 },
    );
  }),
  http.post(`*${ATTACHMENT_CANCEL_ROUTE_PATH}`, () =>
    HttpResponse.json({ cancelled: true }, { status: 200 }),
  ),
  http.get("*/attachments/:attachmentId", async () => {
    if (attachmentResponseDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(() => resolve(), attachmentResponseDelayMs);
      });
    }
    return HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    });
  }),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

function installImmediateScrollToSpy(
  scrollContainer: HTMLElement,
  config?: { readonly suspendSmoothScroll?: boolean },
): {
  readonly calls: ScrollToOptions[];
  readonly restore: () => void;
} {
  const originalScrollTo = scrollContainer.scrollTo;
  const calls: ScrollToOptions[] = [];
  scrollContainer.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
    const normalized: ScrollToOptions =
      typeof options === "object" && options !== null
        ? options
        : {
            ...(typeof options === "number" ? { left: options } : {}),
            ...(typeof y === "number" ? { top: y } : {}),
          };
    calls.push(normalized);
    if (config?.suspendSmoothScroll && normalized.behavior === "smooth") {
      return;
    }
    if (typeof normalized.left === "number") {
      scrollContainer.scrollLeft = normalized.left;
    }
    if (typeof normalized.top === "number") {
      scrollContainer.scrollTop = normalized.top;
    }
    scrollContainer.dispatchEvent(new Event("scroll"));
  }) as typeof scrollContainer.scrollTo;

  return {
    calls,
    restore: () => {
      scrollContainer.scrollTo = originalScrollTo;
    },
  };
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

function readDispatchedCommand(request: WsRequestEnvelope["body"]): Record<string, unknown> | null {
  if (
    request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand ||
    typeof request.command !== "object" ||
    request.command === null
  ) {
    return null;
  }
  return request.command as Record<string, unknown>;
}

function hasDispatchedCommandType(type: string): boolean {
  return wsRequests.some((request) => readDispatchedCommand(request)?.type === type);
}

async function waitForEnvironmentModeButton(label: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === label,
      ) ?? null,
    `Unable to find ${label} environment button.`,
  );
}

async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(wsRequests.some((request) => request._tag === WS_METHODS.serverGetConfig)).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

function dispatchComposerPickerShortcut(target: EventTarget, key: "m" | "e"): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchModelCycleShortcut(target: EventTarget, key: "[" | "]"): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key === "]" ? "BracketRight" : "BracketLeft",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

async function dispatchModelCycleShortcutWhenReady(
  target: EventTarget,
  key: "[" | "]",
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(dispatchModelCycleShortcut(target, key).defaultPrevented).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

function dispatchConfiguredShortcut(
  target: EventTarget,
  input: { key: string; shiftKey?: boolean; altKey?: boolean },
): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: input.key,
      shiftKey: input.shiftKey ?? false,
      altKey: input.altKey ?? false,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchComposerFocusToggleShortcut(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "l",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

// The composer model/effort shortcuts both drop into the same combined picker,
// rendered as a Base UI menu popup. Provider and effort detail live in lazily
// mounted submenus, so the reliable signal that the surface opened is the popup
// mounting with the active model label (the fixture pins the thread to gpt-5).
async function waitForComposerPickerSurfaceOpen(): Promise<void> {
  await vi.waitFor(() => {
    const popup = document.querySelector('[data-slot="menu-popup"]');
    expect(popup).not.toBeNull();
    expect(popup?.textContent ?? "").toContain("GPT-5");
  });
}

function dispatchChatNewShortcut(): void {
  dispatchThreadShortcut("o");
}

function dispatchTerminalThreadShortcut(): void {
  dispatchThreadShortcut("t");
}

function dispatchThreadShortcut(key: string): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(router, dispatchChatNewShortcut, predicate, errorMessage);
}

async function triggerTerminalThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(
    router,
    dispatchTerminalThreadShortcut,
    predicate,
    errorMessage,
  );
}

async function triggerThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  dispatchShortcut: () => void,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = router.state.location.pathname;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    dispatchShortcut();
    await waitForLayout();
    pathname = router.state.location.pathname;
    if (predicate(pathname)) {
      return pathname;
    }
  }
  throw new Error(`${errorMessage} Last path: ${pathname}`);
}

async function waitForNewThreadShortcutLabel(): Promise<void> {
  const newThreadButton = page.getByTestId("new-thread-button");
  await expect.element(newThreadButton).toBeInTheDocument();
  await waitForLayout();
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

async function measureUserRow(options: {
  host: HTMLElement;
  targetMessageId: MessageId;
}): Promise<UserRowMeasurement> {
  const { host, targetMessageId } = options;
  const rowSelector = `[data-message-id="${targetMessageId}"][data-message-role="user"]`;

  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );

  let row: HTMLElement | null = null;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      row = host.querySelector<HTMLElement>(rowSelector);
      expect(row, "Unable to locate targeted user message row.").toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );

  await waitForImagesToLoad(row!);
  scrollContainer.scrollTop = 0;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await nextFrame();

  let timelineWidthMeasuredPx = 0;
  let measuredRowHeightPx = 0;
  let renderedInVirtualizedRegion = false;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      expect(measuredRow, "Unable to measure targeted user row height.").toBeTruthy();
      timelineWidthMeasuredPx = measuredRow!.getBoundingClientRect().width;
      measuredRowHeightPx = measuredRow!.getBoundingClientRect().height;
      renderedInVirtualizedRegion = measuredRow!.closest("[data-index]") instanceof HTMLElement;
      expect(timelineWidthMeasuredPx, "Unable to measure timeline width.").toBeGreaterThan(0);
      expect(measuredRowHeightPx, "Unable to measure targeted user row height.").toBeGreaterThan(0);
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  return { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion };
}

async function measureChatLayout(host: HTMLElement): Promise<ChatLayoutMeasurement> {
  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );
  const composerForm = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-composer-form='true']"),
    "Unable to find chat composer form.",
  );

  await waitForLayout();

  const hostHeightPx = host.getBoundingClientRect().height;
  const composerBottomPx = composerForm.getBoundingClientRect().bottom;
  return {
    hostHeightPx,
    composerBottomPx,
    scrollClientHeightPx: scrollContainer.clientHeight,
    scrollHeightPx: scrollContainer.scrollHeight,
    distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
  };
}

async function waitForMountedChatReady(options: {
  host: HTMLElement;
  snapshot: OrchestrationReadModel;
  routeThreadId: ThreadId;
}): Promise<void> {
  const expectedThread = options.snapshot.threads.find(
    (thread) => thread.id === options.routeThreadId,
  );

  await vi.waitFor(
    () => {
      expect(
        options.host.querySelector("[data-chat-composer-form='true']"),
        "Chat composer did not mount.",
      ).toBeTruthy();
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.serverGetConfig),
        "Browser RPC configuration did not load.",
      ).toBe(true);

      if (!expectedThread) return;
      const state = useStore.getState();
      expect(state.threadIds?.includes(expectedThread.id)).toBe(true);
      const hydratedMessageIdSet = new Set(state.messageIdsByThreadId?.[expectedThread.id] ?? []);
      expect(
        expectedThread.messages.every((message) => hydratedMessageIdSet.has(message.id)),
        "Active thread detail did not hydrate.",
      ).toBe(true);
    },
    { timeout: 20_000, interval: 16 },
  );
  await waitForLayout();
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  initialEntry?: string;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = createFullscreenTestHost();

  const initialEntry = options.initialEntry ?? `/${THREAD_ID}`;

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [initialEntry],
    }),
  );

  const screen = await render(<RouterProvider router={router} />, {
    container: host,
  });

  try {
    await waitForMountedChatReady({
      host,
      snapshot: options.snapshot,
      routeThreadId: ThreadId.makeUnsafe(initialEntry.slice(1)),
    });
  } catch (cause) {
    await screen.unmount();
    if (host.isConnected) host.remove();
    throw cause;
  }

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await screen.unmount();
    if (host.isConnected) host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    measureLayout: async () => measureChatLayout(host),
    measureUserRow: async (targetMessageId: MessageId) => measureUserRow({ host, targetMessageId }),
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    router,
  };
}

async function measureUserRowAtViewport(options: {
  snapshot: OrchestrationReadModel;
  targetMessageId: MessageId;
  viewport: ViewportSpec;
}): Promise<UserRowMeasurement> {
  const mounted = await mountChatView({
    viewport: options.viewport,
    snapshot: options.snapshot,
  });

  try {
    return await mounted.measureUserRow(options.targetMessageId);
  } finally {
    await mounted.cleanup();
  }
}

describe("ChatView timeline estimator parity (full app)", () => {
  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await resetWsNativeApiForTest();
    await worker.stop();
  });

  beforeEach(async () => {
    await resetWsNativeApiForTest();
    resetRetainedThreadDetailSubscriptionsForTests();
    await resetHomeChatProjectPrewarmStateForTests();
    await resetStudioProjectPrewarmStateForTests();
    await setViewport(DEFAULT_VIEWPORT);
    attachmentResponseDelayMs = 0;
    attachmentUploadSequence = 0;
    localStorage.clear();
    useLatestProjectStore.setState({ latestProjectId: null });
    useWorkspacePathsStore.setState({
      homeDir: null,
      chatWorkspaceRoot: null,
      studioWorkspaceRoot: null,
    });
    document.body.innerHTML = "";
    wsRequests.length = 0;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useStore.setState({
      shellSnapshotSequence: 0,
      spaces: [],
      projects: [],
      threadIds: [],
      threadShellById: {},
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      threadDetailSyncById: {},
      deletedProjectIdsById: {},
      deletedThreadIdsById: {},
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
    useTemporaryThreadStore.setState({
      temporaryThreadIds: {},
    });
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
    });
    useSplitViewStore.setState({
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
    });
  });

  afterEach(async () => {
    await resetHomeChatProjectPrewarmStateForTests();
    await resetStudioProjectPrewarmStateForTests();
    resetRetainedThreadDetailSubscriptionsForTests();
    document.body.innerHTML = "";
  });

  it("dispatches a rapid access-mode reversal while the server projection is stale", async () => {
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-runtime-reversal" as MessageId,
      targetText: "runtime reversal",
    });
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) => ({
        ...thread,
        runtimeMode: "approval-required",
        session: thread.session
          ? {
              ...thread.session,
              runtimeMode: "approval-required",
            }
          : null,
      })),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      const supervisedTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title^="Ask for approval:"]'),
        "Unable to find the Ask for approval access-mode trigger.",
      );
      supervisedTrigger.click();
      const autoOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim().startsWith("Approve for me"),
          ) ?? null,
        "Unable to find the Approve for me access-mode option.",
      );
      autoOption.click();

      const autoTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title^="Approve for me:"]'),
        "Approve for me did not become the acknowledged composer access mode.",
      );
      autoTrigger.click();
      const supervisedOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim().startsWith("Ask for approval"),
          ) ?? null,
        "Unable to find the Ask for approval access-mode option.",
      );
      supervisedOption.click();

      await vi.waitFor(
        () => {
          const runtimeModes = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.runtime-mode.set")
            .map((command) => command?.runtimeMode);
          expect(runtimeModes).toEqual(["auto", "approval-required"]);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(TEXT_VIEWPORT_MATRIX)(
    "[geometry:linux] keeps long user message estimate close at the $name viewport",
    async (viewport) => {
      const userText = "x".repeat(3_200);
      const targetMessageId = `msg-user-target-long-${viewport.name}` as MessageId;
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
        }),
      });

      try {
        const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
          await mounted.measureUserRow(targetMessageId);

        expect(renderedInVirtualizedRegion).toBe(true);

        const estimatedHeightPx = estimateTimelineMessageHeight(
          { role: "user", text: userText, attachments: [] },
          { timelineWidthPx: timelineWidthMeasuredPx },
        );

        expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.textTolerancePx,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("[geometry:linux] tracks wrapping parity while resizing an existing ChatView across the viewport matrix", async () => {
    const userText = "x".repeat(3_200);
    const targetMessageId = "msg-user-target-resize" as MessageId;
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: userText,
      }),
    });

    try {
      const measurements: Array<
        UserRowMeasurement & { viewport: ViewportSpec; estimatedHeightPx: number }
      > = [];

      for (const viewport of TEXT_VIEWPORT_MATRIX) {
        await mounted.setViewport(viewport);
        const measurement = await mounted.measureUserRow(targetMessageId);
        const estimatedHeightPx = estimateTimelineMessageHeight(
          { role: "user", text: userText, attachments: [] },
          { timelineWidthPx: measurement.timelineWidthMeasuredPx },
        );

        expect(measurement.renderedInVirtualizedRegion).toBe(true);
        expect(Math.abs(measurement.measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.textTolerancePx,
        );
        measurements.push({ ...measurement, viewport, estimatedHeightPx });
      }

      expect(
        new Set(measurements.map((measurement) => Math.round(measurement.timelineWidthMeasuredPx)))
          .size,
      ).toBeGreaterThanOrEqual(3);

      const byMeasuredWidth = measurements.toSorted(
        (left, right) => left.timelineWidthMeasuredPx - right.timelineWidthMeasuredPx,
      );
      const narrowest = byMeasuredWidth[0]!;
      const widest = byMeasuredWidth.at(-1)!;
      expect(narrowest.timelineWidthMeasuredPx).toBeLessThan(widest.timelineWidthMeasuredPx);
      // Both widths exceed the shared 12-line limit, so resizing must not make
      // the virtualized estimate grow beyond the visible collapsed row.
      expect(narrowest.estimatedHeightPx).toBe(widest.estimatedHeightPx);
      expect(
        Math.abs(narrowest.measuredRowHeightPx - widest.measuredRowHeightPx),
      ).toBeLessThanOrEqual(8);
    } finally {
      await mounted.cleanup();
    }
  });

  it("[geometry:linux] tracks additional rendered wrapping when ChatView width narrows between desktop and mobile viewports", async () => {
    // Short enough to remain below the 12-line collapse at both widths, while
    // still wrapping onto materially more lines on mobile.
    const userText = "x".repeat(320);
    const targetMessageId = "msg-user-target-wrap" as MessageId;
    const snapshot = createSnapshotForTargetUser({
      targetMessageId,
      targetText: userText,
    });
    const desktopMeasurement = await measureUserRowAtViewport({
      viewport: { ...TEXT_VIEWPORT_MATRIX[0], width: 1_400 },
      snapshot,
      targetMessageId,
    });
    const mobileMeasurement = await measureUserRowAtViewport({
      viewport: TEXT_VIEWPORT_MATRIX[2],
      snapshot,
      targetMessageId,
    });

    const estimatedDesktopPx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: desktopMeasurement.timelineWidthMeasuredPx },
    );
    const estimatedMobilePx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: mobileMeasurement.timelineWidthMeasuredPx },
    );

    const measuredDeltaPx =
      mobileMeasurement.measuredRowHeightPx - desktopMeasurement.measuredRowHeightPx;
    const estimatedDeltaPx = estimatedMobilePx - estimatedDesktopPx;
    expect(measuredDeltaPx).toBeGreaterThan(0);
    expect(estimatedDeltaPx).toBeGreaterThan(0);
    const ratio = estimatedDeltaPx / measuredDeltaPx;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(1.35);
  });

  it("[geometry:linux] collapses header actions into overflow before they can overlap the thread title", async () => {
    const longTitle =
      'remove "ago" from the sidebar while the diff panel stays open on smaller viewports';
    const headerOverflowSnapshot = (() => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-header-overflow-target" as MessageId,
        targetText: "header overflow",
      });

      return withProjectScripts(
        {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? Object.assign({}, thread, { title: longTitle }) : thread,
          ),
        },
        [
          {
            id: "dev-server",
            name: "Dev",
            command: "bun run dev",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
      );
    })();
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 540 },
      snapshot: headerOverflowSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await vi.waitFor(
        () => {
          const title = document.querySelector<HTMLElement>(`h2[title='${longTitle}']`);
          const overflowButton = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Toggle environment panel"]',
          );

          expect(title, "Unable to find the chat header title.").toBeTruthy();
          expect(overflowButton, "Unable to find the header overflow trigger.").toBeTruthy();

          const titleRight = title!.getBoundingClientRect().right;
          const actionsLeft = overflowButton!.getBoundingClientRect().left;
          expect(titleRight).toBeLessThanOrEqual(actionsLeft + 1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the active thread title", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-tooltip-target" as MessageId,
        targetText: "thread tooltip target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(THREAD_TITLE);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("[geometry:linux] keeps the composer visible while a long assistant response forces a viewport relayout", async () => {
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotWithLongAssistantResponse(),
    });

    try {
      const desktopLayout = await mounted.measureLayout();
      expect(desktopLayout.scrollClientHeightPx).toBeGreaterThan(0);
      expect(desktopLayout.scrollHeightPx).toBeGreaterThan(desktopLayout.scrollClientHeightPx);
      expect(desktopLayout.composerBottomPx).toBeLessThanOrEqual(desktopLayout.hostHeightPx + 1);

      await mounted.setViewport(TEXT_VIEWPORT_MATRIX[2]);
      const mobileLayout = await mounted.measureLayout();
      expect(mobileLayout.scrollClientHeightPx).toBeGreaterThan(0);
      expect(mobileLayout.scrollHeightPx).toBeGreaterThan(mobileLayout.scrollClientHeightPx);
      expect(mobileLayout.composerBottomPx).toBeLessThanOrEqual(mobileLayout.hostHeightPx + 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("stays pinned to the bottom after delayed attachment loads expand the timeline", async () => {
    attachmentResponseDelayMs = 160;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithBottomAttachments(),
    });

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("img").length).toBeGreaterThanOrEqual(3);
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForImagesToLoad(document.body);
      await vi.waitFor(
        async () => {
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      attachmentResponseDelayMs = 0;
      await mounted.cleanup();
    }
  });

  it("settles the scroll-to-bottom arrow at the measured transcript end", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongAssistantResponse(),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(() => {
        expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      await vi.waitFor(() => {
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      const scrollButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "button[aria-label='Scroll to bottom'][aria-hidden='false']",
          ),
        "Unable to find the visible scroll-to-bottom button.",
      );

      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;

      scrollButton.click();

      await vi.waitFor(
        () => {
          expect(scrollSpy.calls.some((call) => call.behavior === "smooth")).toBe(true);
          expect(scrollSpy.calls.some((call) => call.behavior === "auto")).toBe(true);
          expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(
            AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  it("stops the arrow's smooth scroll when the user scrolls upward", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongAssistantResponse(),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(() => {
        expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);
      });
      // Let mount-time tail expansion retries (max 260ms) finish before
      // isolating the arrow scroll and the user's takeover gesture.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      await waitForLayout();
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      await vi.waitFor(() => {
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      const scrollButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "button[aria-label='Scroll to bottom'][aria-hidden='false']",
          ),
        "Unable to find the visible scroll-to-bottom button.",
      );
      const scrollSpy = installImmediateScrollToSpy(scrollContainer, {
        suspendSmoothScroll: true,
      });
      restoreScrollTo = scrollSpy.restore;

      scrollButton.click();
      await vi.waitFor(() => {
        expect(scrollSpy.calls.some((call) => call.behavior === "smooth")).toBe(true);
      });
      const takeoverOffset = scrollContainer.scrollTop;
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));

      await vi.waitFor(() => {
        expect(scrollSpy.calls.some((call) => call.behavior === "auto")).toBe(true);
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
      const smoothCalls = scrollSpy.calls.filter((call) => call.behavior === "smooth");
      const takeoverCalls = scrollSpy.calls.filter((call) => call.behavior === "auto");
      expect(smoothCalls).toHaveLength(1);
      expect(takeoverCalls.length).toBeGreaterThanOrEqual(1);
      expect(
        takeoverCalls.every(
          (call) =>
            typeof call.top === "number" &&
            call.top <= takeoverOffset + AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        ),
      ).toBe(true);
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  // How the transcript gets there — one motion, no bouncing — is covered by
  // "moves a sent message to its anchor once…"; this guards the outcome: a send
  // from far up the transcript ends pinned at the live edge with focus kept.
  it("re-sticks to the bottom after sending an optimistic user message", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-send-bottom-stick" as MessageId,
        targetText: "bottom stick target",
      }),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );

      // Installed so any native smooth scroll resolves immediately; the send
      // path itself drives the container frame by frame, so this spy is here for
      // determinism rather than to observe the motion.
      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;

      const prompt = "keep me pinned after send";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        async () => {
          expect(document.body.textContent).toContain(prompt);
          expect(document.activeElement).toBe(await waitForComposerEditor());
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(scrollContainer.scrollTop, "transcript never left the top").toBeGreaterThan(0);
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("anchors a freshly sent user message at the top of the transcript viewport", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-send-tail-anchor" as MessageId,
      targetText: "tail anchor target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      // Start where a real conversation sits: parked at the bottom of the transcript.
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const prompt = "anchor this message at the viewport top";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      const findSentRow = () => {
        const rows = document.querySelectorAll<HTMLElement>(
          "[data-message-id][data-message-role='user']",
        );
        for (const row of rows) {
          if (row.textContent?.includes(prompt)) {
            return row;
          }
        }
        return null;
      };

      const anchorOffsetPx = () => {
        const row = findSentRow();
        if (!row) {
          return null;
        }
        return row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
      };
      // The anchored message keeps the same top gap a chat's first message gets:
      // the scroll container's own top padding.
      const expectedTopGapPx = Number.parseFloat(getComputedStyle(scrollContainer).paddingTop) || 0;

      await vi.waitFor(
        () => {
          const offsetPx = anchorOffsetPx();
          expect(offsetPx, "sent user message row not rendered").not.toBeNull();
          expect(Math.abs(offsetPx! - expectedTopGapPx)).toBeLessThanOrEqual(24);
        },
        { timeout: 8_000, interval: 16 },
      );
      // Real sends ack before the turn goes live, so the transcript sits with no
      // running turn for a beat. The anchor must survive that gap instead of
      // collapsing the moment the send stops being "busy".
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 700);
      });
      const offsetAfterAckGapPx = anchorOffsetPx();
      expect(offsetAfterAckGapPx, "sent user message row missing after ack gap").not.toBeNull();
      expect(Math.abs(offsetAfterAckGapPx! - expectedTopGapPx)).toBeLessThanOrEqual(24);

      // The server acknowledges the send and the turn starts running: the durable
      // user message replaces the optimistic row and live turn chrome appears.
      const activeTurnId = TurnId.makeUnsafe("turn-tail-anchor");
      const sentMessageId = findSentRow()?.dataset.messageId;
      expect(sentMessageId, "sent user message id").toBeTruthy();
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(sentMessageId!),
            role: "user" as const,
            text: prompt,
            turnId: activeTurnId,
            streaming: false,
            source: "native" as const,
            createdAt: isoAt(1_300),
            updatedAt: isoAt(1_300),
          },
        ],
        latestTurn: {
          turnId: activeTurnId,
          state: "running",
          requestedAt: isoAt(1_300),
          startedAt: isoAt(1_301),
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? { ...thread.session, status: "running", activeTurnId, updatedAt: isoAt(1_301) }
          : null,
        updatedAt: isoAt(1_301),
      }));
      await waitForLayout();
      await vi.waitFor(
        () => {
          const offsetPx = anchorOffsetPx();
          expect(offsetPx, "sent user message row missing after ack").not.toBeNull();
          expect(Math.abs(offsetPx! - expectedTopGapPx)).toBeLessThanOrEqual(24);
        },
        { timeout: 4_000, interval: 16 },
      );

      // The assistant response streams in below the anchored message. While it is
      // shorter than the viewport the anchored message must not move.
      const streamingId = MessageId.makeUnsafe("msg-assistant-tail-anchor-stream");
      for (const chunkCount of [1, 3, 6]) {
        syncActiveThread((thread) => ({
          ...thread,
          messages: [
            ...thread.messages.filter((message) => message.id !== streamingId),
            {
              id: streamingId,
              role: "assistant" as const,
              text: `Streaming response paragraph.\n\n`.repeat(chunkCount),
              turnId: activeTurnId,
              streaming: true,
              source: "native" as const,
              createdAt: isoAt(1_302),
              updatedAt: isoAt(1_302 + chunkCount),
            },
          ],
          updatedAt: isoAt(1_302 + chunkCount),
        }));
        await waitForLayout();
        await waitForLayout();
        const offsetPx = anchorOffsetPx();
        expect(offsetPx, `anchor row missing while streaming ${chunkCount} chunks`).not.toBeNull();
        expect(
          Math.abs(offsetPx! - expectedTopGapPx),
          `anchor drifted while streaming ${chunkCount} chunks`,
        ).toBeLessThanOrEqual(24);
      }

      // The turn completes: the reserve persists so the settled transcript does
      // not jump back to its true bottom.
      const scrollTopBeforeTurnEnd = scrollContainer.scrollTop;
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === streamingId
            ? { ...message, streaming: false, updatedAt: isoAt(1_400) }
            : message,
        ),
        latestTurn: thread.latestTurn
          ? { ...thread.latestTurn, state: "completed", completedAt: isoAt(1_400) }
          : thread.latestTurn,
        session: thread.session
          ? { ...thread.session, status: "idle", activeTurnId: null, updatedAt: isoAt(1_400) }
          : null,
        updatedAt: isoAt(1_400),
      }));
      await waitForLayout();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 700);
      });
      const offsetAfterTurnEndPx = anchorOffsetPx();
      expect(offsetAfterTurnEndPx, "sent user message row missing after turn end").not.toBeNull();
      expect(
        Math.abs(offsetAfterTurnEndPx! - expectedTopGapPx),
        "anchor jumped when the turn settled",
      ).toBeLessThanOrEqual(24);
      expect(
        Math.abs(scrollContainer.scrollTop - scrollTopBeforeTurnEnd),
        "scroll position jumped when the turn settled",
      ).toBeLessThanOrEqual(2);
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  // Regression: the sent message must reach its anchored coordinate in one
  // motion and then stay there for the rest of the turn. The failure this guards
  // is the message visibly jumping up and down through send → Thinking →
  // "Working for" → streaming, which is what a fixed-target scroll produces once
  // the coordinate moves under it (reserve sizing, rows above being remeasured).
  it("moves a sent message to its anchor once and holds it across the turn lifecycle", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-send-jitter" as MessageId,
      targetText: "jitter target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const prompt = "measure the anchor motion for this send";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      sendButton.click();

      const findSentRow = () => {
        const rows = document.querySelectorAll<HTMLElement>(
          "[data-message-id][data-message-role='user']",
        );
        for (const row of rows) {
          if (row.textContent?.includes(prompt)) return row;
        }
        return null;
      };
      const topGapPx = Number.parseFloat(getComputedStyle(scrollContainer).paddingTop) || 0;

      // Sampled every frame: the regression is a single-frame hop, so polling for
      // the settled state would not see it.
      const samples: Array<{ t: number; offset: number | null }> = [];
      const startedAt = performance.now();
      let sampling = true;
      const sample = () => {
        if (!sampling) return;
        const row = findSentRow();
        samples.push({
          t: performance.now() - startedAt,
          offset: row
            ? row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top
            : null,
        });
        window.requestAnimationFrame(sample);
      };
      window.requestAnimationFrame(sample);

      const at = (ms: number, action: () => void) => window.setTimeout(action, ms);
      const activeTurnId = TurnId.makeUnsafe("turn-jitter");
      const streamingId = MessageId.makeUnsafe("msg-assistant-jitter-stream");

      // Server ack: durable user row + running turn (Thinking appears).
      at(140, () => {
        const sentMessageId = findSentRow()?.dataset.messageId;
        if (!sentMessageId) return;
        syncActiveThread((thread) => ({
          ...thread,
          messages: [
            ...thread.messages,
            {
              id: MessageId.makeUnsafe(sentMessageId),
              role: "user" as const,
              text: prompt,
              turnId: activeTurnId,
              streaming: false,
              source: "native" as const,
              createdAt: isoAt(1_300),
              updatedAt: isoAt(1_300),
            },
          ],
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1_300),
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
          session: thread.session
            ? {
                ...thread.session,
                status: "running" as const,
                activeTurnId,
                updatedAt: isoAt(1_301),
              }
            : null,
          updatedAt: isoAt(1_301),
        }));
      });
      // Turn actually starts: the "Working for" header replaces Thinking.
      at(420, () => {
        syncActiveThread((thread) => ({
          ...thread,
          latestTurn: thread.latestTurn
            ? { ...thread.latestTurn, startedAt: isoAt(1_310) }
            : thread.latestTurn,
          updatedAt: isoAt(1_310),
        }));
      });
      // Rows above the anchor settle to their real height mid-slide (late image
      // loads, markdown remeasure, estimated virtualized rows mounting). Visible
      // content preservation is off while an anchor is set, so this is exactly
      // what shifts the anchored row under the in-flight slide.
      const earlierMessageId = currentSnapshot.threads
        .find((thread) => thread.id === THREAD_ID)!
        .messages.at(-2)!.id;
      for (const [index, delayMs] of [260, 340, 430].entries()) {
        at(delayMs, () => {
          syncActiveThread((thread) => ({
            ...thread,
            messages: thread.messages.map((message) =>
              message.id === earlierMessageId
                ? {
                    ...message,
                    text: `${message.text}\n\n${"Late-measured earlier content. ".repeat(6 * (index + 1))}`,
                    updatedAt: isoAt(1_250 + index),
                  }
                : message,
            ),
            updatedAt: isoAt(1_250 + index),
          }));
        });
      }
      // Assistant text streams in below the anchor, chunk by chunk.
      for (let chunk = 1; chunk <= 24; chunk += 1) {
        at(560 + chunk * 33, () => {
          syncActiveThread((thread) => ({
            ...thread,
            messages: [
              ...thread.messages.filter((message) => message.id !== streamingId),
              {
                id: streamingId,
                role: "assistant" as const,
                text: "Streaming response paragraph.\n\n".repeat(chunk),
                turnId: activeTurnId,
                streaming: true,
                source: "native" as const,
                createdAt: isoAt(1_320),
                updatedAt: isoAt(1_320 + chunk),
              },
            ],
            updatedAt: isoAt(1_320 + chunk),
          }));
        });
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 1_600);
      });
      sampling = false;

      const visible = samples.filter(
        (entry): entry is { t: number; offset: number } => entry.offset !== null,
      );
      const firstArrivalIndex = visible.findIndex(
        (entry) => Math.abs(entry.offset - topGapPx) <= 2,
      );
      const settled = firstArrivalIndex >= 0 ? visible.slice(firstArrivalIndex) : [];
      let reversals = 0;
      let travelAfterArrivalPx = 0;
      let maxDownwardJumpPx = 0;
      let previousDirection = 0;
      for (let index = 1; index < settled.length; index += 1) {
        const delta = settled[index]!.offset - settled[index - 1]!.offset;
        travelAfterArrivalPx += Math.abs(delta);
        maxDownwardJumpPx = Math.max(maxDownwardJumpPx, delta);
        if (Math.abs(delta) <= 0.5) continue;
        const direction = Math.sign(delta);
        if (previousDirection !== 0 && direction !== previousDirection) reversals += 1;
        previousDirection = direction;
      }
      const maxDriftAfterArrivalPx = settled.reduce(
        (worst, entry) => Math.max(worst, Math.abs(entry.offset - topGapPx)),
        0,
      );
      // The approach itself must not bounce: every frame moves the message
      // toward the anchor, never back down and up again.
      const approach = firstArrivalIndex >= 0 ? visible.slice(0, firstArrivalIndex + 1) : visible;
      let approachReversals = 0;
      let approachDirection = 0;
      for (let index = 1; index < approach.length; index += 1) {
        const delta = approach[index]!.offset - approach[index - 1]!.offset;
        if (Math.abs(delta) <= 0.5) continue;
        const direction = Math.sign(delta);
        if (approachDirection !== 0 && direction !== approachDirection) approachReversals += 1;
        approachDirection = direction;
      }
      // ...and it has to be a glide, not a teleport. A loaded browser runner
      // can deliver animation frames far apart, so fixed frame counts and
      // per-sample distance caps turn scheduler starvation into false failures.
      // Requiring multiple observable positions between the endpoints still
      // rejects a teleport while remaining independent of frame cadence.
      const approachStartOffsetPx = approach[0]?.offset ?? topGapPx;
      const intermediateApproachSamples = approach.filter(
        (entry) => entry.offset < approachStartOffsetPx - 2 && entry.offset > topGapPx + 2,
      );

      const trace = () =>
        visible.map((entry) => `${Math.round(entry.t)}:${Math.round(entry.offset)}`).join(" ");
      expect(
        firstArrivalIndex,
        `sent message never reached its anchor: ${trace()}`,
      ).toBeGreaterThan(-1);
      expect(
        visible[firstArrivalIndex]!.t - (visible[0]?.t ?? 0),
        `anchor took too long to land: ${trace()}`,
      ).toBeLessThan(900);
      expect(approachReversals, `anchor bounced on its way up: ${trace()}`).toBeLessThanOrEqual(1);
      expect(
        intermediateApproachSamples.length,
        `anchor jumped instead of gliding: ${trace()}`,
      ).toBeGreaterThanOrEqual(2);
      expect(reversals, `anchor moved back and forth after landing: ${trace()}`).toBe(0);
      expect(maxDownwardJumpPx, `anchor slid back down after landing: ${trace()}`).toBeLessThan(2);
      expect(travelAfterArrivalPx, `anchor kept moving after landing: ${trace()}`).toBeLessThan(8);
      expect(maxDriftAfterArrivalPx, `anchor drifted off its coordinate: ${trace()}`).toBeLessThan(
        4,
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("auto-follows real transcript changes without re-sticking for non-message activity", async () => {
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-auto-follow-wiring" as MessageId,
      targetText: "auto-follow wiring target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });
    let restoreScrollTo = () => {};

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;
      // Let mount-time tail/image expansion retries (max 260ms) settle before
      // isolating scrolls caused by the state transitions below.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      await waitForLayout();
      scrollSpy.calls.length = 0;

      // Buffering/connecting state changes generic turn chrome, but does not add a
      // transcript message and therefore must not re-stick the transcript.
      syncActiveThread((thread) => ({
        ...thread,
        session: thread.session
          ? {
              ...thread.session,
              status: "starting",
              updatedAt: isoAt(1_201),
            }
          : null,
        updatedAt: isoAt(1_201),
      }));
      await waitForLayout();
      expect(scrollSpy.calls).toHaveLength(0);

      const activeTurnId = TurnId.makeUnsafe("turn-auto-follow-wiring");
      syncActiveThread((thread) => ({
        ...thread,
        latestTurn: {
          turnId: activeTurnId,
          state: "running",
          requestedAt: isoAt(1_202),
          startedAt: isoAt(1_203),
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? {
              ...thread.session,
              status: "running",
              activeTurnId,
              updatedAt: isoAt(1_204),
            }
          : null,
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe("activity-auto-follow-approval"),
            createdAt: isoAt(1_204),
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            turnId: activeTurnId,
            payload: {
              requestId: "request-auto-follow",
              requestKind: "command",
              detail: "inspect the unchanged transcript tail",
            },
          },
        ],
        updatedAt: isoAt(1_204),
      }));
      await waitForLayout();
      expect(scrollSpy.calls).toHaveLength(0);

      syncActiveThread((thread) => ({
        ...thread,
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe("activity-auto-follow-tool"),
            createdAt: isoAt(1_205),
            kind: "tool.completed",
            summary: "scroll-only tool activity",
            tone: "tool",
            turnId: activeTurnId,
            payload: {
              itemType: "dynamic_tool_call",
              toolName: "inspect-scroll-tail",
            },
          },
        ],
        updatedAt: isoAt(1_205),
      }));
      await waitForLayout();
      expect(scrollSpy.calls).toHaveLength(0);

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      scrollSpy.calls.length = 0;
      const liveAssistantMessage = {
        ...createAssistantMessage({
          id: MessageId.makeUnsafe("msg-assistant-auto-follow-live"),
          text: "A real live assistant tail",
          offsetSeconds: 1_206,
        }),
        turnId: activeTurnId,
        streaming: true,
      };
      syncActiveThread((thread) => ({
        ...thread,
        messages: [...thread.messages, liveAssistantMessage],
        updatedAt: isoAt(1_206),
      }));
      await vi.waitFor(() => expect(scrollSpy.calls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });

      scrollSpy.calls.length = 0;
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === liveAssistantMessage.id
            ? {
                ...message,
                text: `${message.text}\n\nA second streamed chunk that grows the live response.`,
                updatedAt: isoAt(1_207),
              }
            : message,
        ),
        updatedAt: isoAt(1_207),
      }));
      await vi.waitFor(() => expect(scrollSpy.calls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });

      scrollSpy.calls.length = 0;
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === liveAssistantMessage.id
            ? {
                ...message,
                streaming: false,
                completedAt: isoAt(1_208),
                updatedAt: isoAt(1_208),
              }
            : message,
        ),
        updatedAt: isoAt(1_208),
      }));
      await vi.waitFor(() => expect(scrollSpy.calls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  it("sends unmarked automation questions as normal chat messages", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-automation-question" as MessageId,
        targetText: "automation question target",
      }),
    });

    try {
      const prompt = "how do automations work every day?";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain(prompt);
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find((request) => {
            const command = readDispatchedCommand(request);
            return command?.type === "thread.turn.start";
          });
          expect(turnStartRequest).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(wsRequests.some((request) => request._tag === WS_METHODS.automationCreate)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates composer automations as heartbeat runs on the current chat", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-current-chat-automation" as MessageId,
        targetText: "current chat automation target",
      }),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "/automation say hi every 15 seconds 3 times total");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const automationCreateRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.automationCreate,
          );
          expect(automationCreateRequest).toMatchObject({
            _tag: WS_METHODS.automationCreate,
            mode: "heartbeat",
            targetThreadId: THREAD_ID,
            sourceThreadId: THREAD_ID,
            worktreeMode: "auto",
            maxIterations: 3,
            prompt: "say hi",
            schedule: { type: "interval", everySeconds: 15 },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();

      expect(hasDispatchedCommandType("thread.create")).toBe(false);
      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates polite composer automation requests as heartbeat runs", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-polite-chat-automation" as MessageId,
        targetText: "polite current chat automation target",
      }),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "could you say hi every 15 seconds for 3 times");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("could you say hi");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const automationCreateRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.automationCreate,
          );
          expect(automationCreateRequest).toMatchObject({
            _tag: WS_METHODS.automationCreate,
            mode: "heartbeat",
            targetThreadId: THREAD_ID,
            sourceThreadId: THREAD_ID,
            worktreeMode: "auto",
            maxIterations: 3,
            prompt: "say hi",
            schedule: { type: "interval", everySeconds: 15 },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();

      expect(hasDispatchedCommandType("thread.create")).toBe(false);
      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes draft chats before creating composer heartbeat automations", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "feature/draft-automation",
          worktreePath: "/repo/worktrees/draft-automation",
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: {
        reasoningEffort: "low",
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "/automation say hi every 15 seconds for 3 times");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await vi.waitFor(
        () => {
          const createThreadIndex = wsRequests.findIndex((request) => {
            const command = readDispatchedCommand(request);
            return command?.type === "thread.create" && command.threadId === THREAD_ID;
          });
          const automationCreateIndex = wsRequests.findIndex(
            (request) => request._tag === WS_METHODS.automationCreate,
          );
          expect(createThreadIndex).toBeGreaterThanOrEqual(0);
          expect(automationCreateIndex).toBeGreaterThan(createThreadIndex);

          const createThreadCommand = readDispatchedCommand(wsRequests[createThreadIndex]!);
          expect(createThreadCommand).toMatchObject({
            type: "thread.create",
            threadId: THREAD_ID,
            envMode: "worktree",
            branch: "feature/draft-automation",
            worktreePath: "/repo/worktrees/draft-automation",
            associatedWorktreePath: "/repo/worktrees/draft-automation",
            associatedWorktreeBranch: "feature/draft-automation",
            associatedWorktreeRef: "feature/draft-automation",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "low",
              },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
          });

          expect(wsRequests[automationCreateIndex]).toMatchObject({
            _tag: WS_METHODS.automationCreate,
            mode: "heartbeat",
            targetThreadId: THREAD_ID,
            sourceThreadId: THREAD_ID,
            worktreeMode: "auto",
            maxIterations: 3,
            prompt: "say hi",
            schedule: { type: "interval", everySeconds: 15 },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();

      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not promote draft chats until a reviewed automation is submitted", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "/automation say hi every 15 seconds");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await expect.element(page.getByText("Fast recurring loop")).toBeInTheDocument();
      expect(hasDispatchedCommandType("thread.create")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.automationCreate)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(ATTACHMENT_VIEWPORT_MATRIX)(
    "[geometry:linux] keeps user attachment estimate close at the $name viewport",
    async (viewport) => {
      const targetMessageId = `msg-user-target-attachments-${viewport.name}` as MessageId;
      const userText = "message with image attachments";
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
          targetAttachmentCount: 3,
        }),
      });

      try {
        const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
          await mounted.measureUserRow(targetMessageId);

        expect(renderedInVirtualizedRegion).toBe(true);

        const estimatedHeightPx = estimateTimelineMessageHeight(
          {
            role: "user",
            text: userText,
            attachments: [{ id: "attachment-1" }, { id: "attachment-2" }, { id: "attachment-3" }],
          },
          { timelineWidthPx: timelineWidthMeasuredPx },
        );

        expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.attachmentTolerancePx,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("opens the project cwd for draft threads without a worktree path", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      const openInVsCodeTrigger = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent?.trim() === "Open in VS Code",
          ) ?? null,
        "Unable to find Open in VS Code environment row.",
      );
      openInVsCodeTrigger.click();

      const vscodeOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim() === "VS Code",
          ) ?? null,
        "Unable to find VS Code editor option.",
      );
      vscodeOption.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows branch tools on a fresh top-level thread before any messages", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID),
    });

    try {
      await expect.element(page.getByText("What should we do in")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Local" })).toBeInTheDocument();
      expect(document.body.textContent).toContain("main");
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from local draft threads at the project cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Lint",
          ) as HTMLButtonElement | null,
        "Unable to find Run Lint button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.terminalOpen && request.cwd === "/repo/project",
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/project",
            env: {
              SYNARA_PROJECT_ROOT: "/repo/project",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const writeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalWrite,
          );
          expect(writeRequest).toMatchObject({
            _tag: WS_METHODS.terminalWrite,
            threadId: THREAD_ID,
            data: "bun run lint\r",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from worktree draft threads at the worktree cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "feature/draft",
          worktreePath: "/repo/worktrees/feature-draft",
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "test",
          name: "Test",
          command: "bun run test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Test",
          ) as HTMLButtonElement | null,
        "Unable to find Run Test button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.terminalOpen &&
              request.cwd === "/repo/worktrees/feature-draft",
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/worktrees/feature-draft",
            env: {
              SYNARA_PROJECT_ROOT: "/repo/project",
              SYNARA_WORKTREE_PATH: "/repo/worktrees/feature-draft",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      const readInteractionMode = () =>
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode ?? "default";
      expect(readInteractionMode()).toBe("default");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect(readInteractionMode()).toBe("default");

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          expect(readInteractionMode()).toBe("plan");
          const planButton = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button"),
          ).find((button) => button.textContent?.trim() === "Plan");
          expect(planButton?.title).toContain("return to normal build mode");
        },
        { timeout: 8_000, interval: 16 },
      );

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          expect(readInteractionMode()).toBe("default");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles composer focus with Cmd+L", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-composer-focus-shortcut" as MessageId,
        targetText: "composer focus shortcut",
      }),
    });
    const focusTarget = document.createElement("button");
    focusTarget.type = "button";
    focusTarget.textContent = "Focus sink";
    document.body.appendChild(focusTarget);

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      focusTarget.focus();
      expect(document.activeElement).toBe(focusTarget);

      const focusEvent = dispatchComposerFocusToggleShortcut();
      expect(focusEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(composerEditor);
      });

      const blurEvent = dispatchComposerFocusToggleShortcut();
      expect(blurEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.activeElement).not.toBe(composerEditor);
      });
    } finally {
      focusTarget.remove();
      await mounted.cleanup();
    }
  });

  it("opens the composer model picker surface", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-picker-shortcut" as MessageId,
        targetText: "model picker shortcut",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "m");

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("cycles the active provider model without opening the picker", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-cycle-shortcut" as MessageId,
        targetText: "model cycle shortcut",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();

      await dispatchModelCycleShortcutWhenReady(composerEditor, "]");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ provider: "codex", model: "gpt-5.5" });
      });
      expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();

      await dispatchModelCycleShortcutWhenReady(composerEditor, "[");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ provider: "codex", model: "gpt-5.2" });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the composer model picker with configured keybinding labels loaded", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-picker-configured-shortcut" as MessageId,
        targetText: "configured model picker shortcut",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "modelPicker.toggle",
              shortcut: {
                key: "m",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: true,
                modKey: true,
              },
            },
          ],
        };
      },
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchConfiguredShortcut(composerEditor, { key: "m", altKey: true });

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the composer effort picker surface", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-picker-shortcut" as MessageId,
        targetText: "effort picker shortcut",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "e");

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const store = useComposerDraftStore.getState();
      const currentPrompt = store.draftsByThreadId[THREAD_ID]?.prompt ?? "";
      const nextPrompt = removeInlineTerminalContextPlaceholder(currentPrompt, 0);
      store.setPrompt(THREAD_ID, nextPrompt.prompt);
      store.removeTerminalContext(THREAD_ID, "ctx-removed");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_ID,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables send when the composer only contains an expired terminal pill", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as MessageId,
        targetText: "expired pill disabled target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_ID, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends every browser annotation as prompt context without upload attachments", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const prompt = "Delete everything I annotated.";
    const store = useComposerDraftStore.getState();
    store.setPrompt(THREAD_ID, prompt);
    expect(
      store.addBrowserAnnotation(THREAD_ID, {
        id: "annotation-without-comment",
        tabId: "tab-a",
        source: {
          url: "https://example.test/landing",
          pageTitle: "Landing page",
        },
        selector: "#hero-title",
        tagName: "h1",
        role: null,
        name: null,
        text: "Build faster",
        fingerprint: "fnv1a64:0123456789abcdef",
        comment: null,
        capturedAt: NOW_ISO,
      }),
    ).toBe(true);
    expect(
      store.addBrowserAnnotation(THREAD_ID, {
        id: "annotation-with-comment",
        tabId: "tab-a",
        source: {
          url: "https://example.test/pricing",
          pageTitle: "Pricing",
        },
        selector: "#legacy-plan",
        tagName: "section",
        role: "region",
        name: "Legacy plan",
        text: "Legacy",
        fingerprint: "fnv1a64:fedcba9876543210",
        comment: "This one is obsolete.",
        capturedAt: NOW_ISO,
      }),
    ).toBe(true);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-browser-annotations-send" as MessageId,
        targetText: "browser annotations send target",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-testid="browser-annotation-chip"]')).toHaveLength(
          2,
        );
      });

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof candidate.command === "object" &&
              candidate.command !== null &&
              "type" in candidate.command &&
              candidate.command.type === "thread.turn.start",
          );
          expect(request).toBeTruthy();
          const command = request!.command as {
            message?: { messageId?: unknown; text?: unknown; attachments?: unknown[] };
          };
          expect(typeof command.message?.messageId).toBe("string");
          expect(typeof command.message?.text).toBe("string");
          const serializedPayload = (command.message!.text as string).split("\n").at(-2);
          expect(serializedPayload).toBeTruthy();
          expect(JSON.parse(serializedPayload!)?.messageId).toBe(command.message!.messageId);
          const extracted = extractTrailingBrowserAnnotations(
            command.message!.text as string,
            MessageId.makeUnsafe(command.message!.messageId as string),
          );
          expect(extracted.promptText).toBe(prompt);
          expect(
            extracted.annotations.map(({ id, ordinal, comment, source }) => ({
              id,
              ordinal,
              comment,
              url: source.url,
            })),
          ).toEqual([
            {
              id: "annotation-without-comment",
              ordinal: 1,
              comment: null,
              url: "https://example.test/landing",
            },
            {
              id: "annotation-with-comment",
              ordinal: 2,
              comment: "This one is obsolete.",
              url: "https://example.test/pricing",
            },
          ]);
          expect(command.message?.attachments ?? []).toHaveLength(0);
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.browserAnnotations ?? [],
          ).toHaveLength(0);
          expect(document.body.textContent).not.toContain("<browser_annotations>");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("shows a pointer cursor for the running stop button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as MessageId,
        targetText: "stop button cursor target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a queued follow-up row while a turn is running", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "queue this follow-up");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-queue-button" as MessageId,
        targetText: "running queue button target",
        sessionStatus: "running",
      }),
    });

    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("queue this follow-up");
          expect(document.body.textContent).toContain("Steer");
        },
        { timeout: 8_000, interval: 16 },
      );

      const queuedRow = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="queued-follow-up-row"]'),
        "Unable to find queued follow-up row.",
      );
      expect(queuedRow).not.toBeNull();

      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );
      expect(stopButton).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("steers a running turn when Follow-up behavior is set to Steer", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ followUpBehavior: "steer" }));
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "steer this running turn");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-steer-setting" as MessageId,
        targetText: "running steer setting target",
        sessionStatus: "running",
      }),
    });

    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          const turnStart = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.turn.start" &&
                command.dispatchMode === "steer" &&
                typeof command.message === "object" &&
                command.message !== null &&
                "text" in command.message &&
                typeof command.message.text === "string" &&
                command.message.text.includes("steer this running turn"),
            );
          expect(turnStart).toBeTruthy();
          expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
          expect(document.body.textContent).toContain("Steering conversation");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps queued follow-ups when you switch threads and come back", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "queue survives thread switch");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-running-queue-switch" as MessageId,
          targetText: "running queue switch target",
          sessionStatus: "running",
        }),
        OTHER_THREAD_ID,
      ),
    });
    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(document.body.textContent).toContain("queue survives thread switch");
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(document.body.textContent).toContain("queue survives thread switch");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("editing a queued follow-up removes only that row and restores its images to the composer", async () => {
    const queuedImage = createComposerImage({
      id: "queued-image-1",
      previewUrl: "blob:queued-image-1",
      name: "queued-image.png",
    });
    const firstQueuedPrompt = "first queued prompt with image";
    const secondQueuedPrompt = "second queued prompt stays queued";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-edit-queue" as MessageId,
        targetText: "running edit queue target",
        sessionStatus: "running",
      }),
    });

    try {
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-1",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: firstQueuedPrompt,
        prompt: firstQueuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-2",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: secondQueuedPrompt,
        prompt: secondQueuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(2);
        },
        { timeout: 8_000, interval: 16 },
      );

      const actionButtons = document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Queued follow-up actions"]',
      );
      actionButtons[0]?.click();

      const editMenuItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Edit queued prompt",
          ) ?? null,
        "Unable to find edit queued prompt menu item.",
      );
      editMenuItem.click();

      await vi.waitFor(
        () => {
          const queuedRows = document.querySelectorAll<HTMLElement>(
            '[data-testid="queued-follow-up-row"]',
          );
          expect(queuedRows).toHaveLength(1);
          expect(queuedRows[0]?.textContent ?? "").toContain(secondQueuedPrompt);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            firstQueuedPrompt,
          );
          expect(
            useComposerDraftStore
              .getState()
              .draftsByThreadId[THREAD_ID]?.images.map((image) => image.name),
          ).toEqual(["queued-image.png"]);
          // The restored image renders as a thumbnail chip whose filename lives in
          // its accessible label/title, not in text content.
          expect(document.querySelector('[aria-label="Preview queued-image.png"]')).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("auto-dispatches a queued turn without wiping the live composer draft", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const queuedPrompt = "queued prompt that should auto-send";
    const draftBeingTyped = "draft the user is still typing";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-auto-dispatch-target" as MessageId,
        targetText: "auto dispatch target",
        // Idle session so the auto-dispatch effect (gated on phase !== "running")
        // drains the queue, mirroring a turn that just finished.
        sessionStatus: "ready",
      }),
    });

    try {
      // The user is mid-draft in the composer while a turn-completion drain fires.
      useComposerDraftStore.getState().setPrompt(THREAD_ID, draftBeingTyped);
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-auto",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          // Queue drained...
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
          // ...but the in-progress composer draft is left untouched.
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            draftBeingTyped,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("auto-dispatches a queued chat turn as a chat message even while a plan follow-up is pending", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const queuedPrompt = "queued chat turn that must stay a chat message";
    const queuedImage = createComposerImage({
      id: "queued-plan-image-1",
      previewUrl: "blob:queued-plan-image-1",
      name: "queued-plan-image.png",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      // Plan mode, settled turn, actionable proposed plan -> the live composer is
      // showing the plan follow-up prompt at the moment the queue drains.
      snapshot: createSnapshotWithSettledPlanAwaitingFollowUp(),
    });

    try {
      await waitForComposerEditor();
      // Make the live composer's interaction mode explicitly "plan" so the
      // plan-follow-up branch in onSend is live. The queued chat turn below
      // carries its own "default" mode and an image attachment, both of which the
      // misroute (onSubmitPlanFollowUp) would discard.
      useComposerDraftStore.getState().setInteractionMode(THREAD_ID, "plan");
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-plan-chat",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          const command = turnStartRequest!.command as {
            interactionMode?: unknown;
            message?: { attachments?: Array<{ type?: unknown; name?: unknown }> };
          };
          // Dispatched as a normal chat turn: it keeps the queued turn's own
          // "default" interaction mode rather than being coerced to "plan" by the
          // plan-follow-up path.
          expect(command.interactionMode).toBe("default");
          // ...and the queued image survives instead of being dropped to [].
          const attachments = command.message?.attachments ?? [];
          expect(attachments).toHaveLength(1);
          expect(attachments[0]?.type).toBe("image");
          expect(attachments[0]?.name).toBe("queued-plan-image.png");
          // Queue drained.
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("keeps the new thread selected after clicking the new-thread button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
    });

    try {
      // Wait for the sidebar to render with the project.
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      // The route should change to a new draft thread ID.
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      // Simulate the snapshot sync arriving from the server after the draft
      // thread has been promoted to a server thread (thread.create + turn.start
      // succeeded). The snapshot now includes the new thread, and the sync
      // should clear the draft without disrupting the route.
      const { syncServerReadModel } = useStore.getState();
      syncServerReadModel(addThreadToSnapshot(fixture.snapshot, newThreadId));

      // Clear the draft now that the server thread exists (mirrors EventRouter behavior).
      useComposerDraftStore.getState().clearDraftThread(newThreadId);

      // The route should still be on the new thread — not redirected away.
      await waitForURL(
        mounted.router,
        (path) => path === newThreadPath,
        "New thread should remain selected after snapshot sync clears the draft.",
      );

      // The empty thread view and composer should still be visible.
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the latest ordinary project from Home when the global New thread button is clicked", async () => {
    useLatestProjectStore.setState({ latestProjectId: PROJECT_ID });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveHomeChatThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-global-new-thread-latest-project" as MessageId,
          targetText: "global new thread latest project",
        }),
      ),
    });

    try {
      const newThreadButton = page.getByRole("button", { name: "New thread", exact: true });
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Global New thread should create a draft in the latest ordinary project.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.projectId).toBe(
        PROJECT_ID,
      );
      await expect.element(page.getByText("Type path", { exact: true })).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the latest ordinary project when New chat is clicked from Activity", async () => {
    useLatestProjectStore.setState({ latestProjectId: PROJECT_ID });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveHomeChatThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-activity-new-chat-latest-project" as MessageId,
          targetText: "activity new chat latest project",
        }),
      ),
    });

    try {
      await page.getByRole("button", { name: "Switch to activity view" }).click();
      const activityNewChatButton = page.getByRole("button", {
        name: "Start new chat in last used project",
      });
      await expect.element(activityNewChatButton).toBeInTheDocument();
      await activityNewChatButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Activity New chat should create a draft in the latest ordinary project.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.projectId).toBe(
        PROJECT_ID,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the latest ordinary project from Home for the command-palette New thread action", async () => {
    useLatestProjectStore.setState({ latestProjectId: PROJECT_ID });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveHomeChatThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-palette-new-thread-latest-project" as MessageId,
          targetText: "palette new thread latest project",
        }),
      ),
    });

    try {
      // The sidebar header renders Search as an icon button, so its accessible
      // name is the only stable handle.
      const searchButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Search"]'),
        "Unable to find the global Search button.",
      );
      searchButton.click();
      const paletteNewThreadAction = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')).find(
            (item) => item.textContent?.trim().startsWith("New thread"),
          ) ?? null,
        "Unable to find the command-palette New thread action.",
      );
      paletteNewThreadAction.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Command-palette New thread should create a draft in the latest ordinary project.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.projectId).toBe(
        PROJECT_ID,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens Add project when the global New thread action has no usable project target", async () => {
    useLatestProjectStore.setState({ latestProjectId: PROJECT_ID });
    const snapshot = withActiveHomeChatThread(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-global-new-thread-no-project" as MessageId,
        targetText: "global new thread no project",
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: snapshot.projects.filter((project) => project.kind !== "project"),
      },
    });

    try {
      const initialPath = mounted.router.state.location.pathname;
      const newThreadButton = page.getByRole("button", { name: "New thread", exact: true });
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe(initialPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not open Add project before project hydration completes", async () => {
    useLatestProjectStore.setState({ latestProjectId: PROJECT_ID });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveHomeChatThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-global-new-thread-before-hydration" as MessageId,
          targetText: "global new thread before hydration",
        }),
      ),
    });

    try {
      useStore.setState({ projects: [], threadsHydrated: false });
      await waitForLayout();
      const initialPath = mounted.router.state.location.pathname;
      const newThreadButton = page.getByRole("button", { name: "New thread", exact: true });
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();
      await waitForLayout();

      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .not.toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe(initialPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets an empty project draft switch to another open project", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withOpenProjectPickerFixtures(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-switch-test" as MessageId,
          targetText: "project picker switch test",
        }),
      ),
    });

    try {
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      useComposerDraftStore.getState().setDraftThreadContext(newThreadId, {
        envMode: "worktree",
        branch: "feature/keep-out",
        worktreePath: "/repo/project/.worktrees/feature-keep-out",
      });
      useComposerDraftStore.getState().setProjectDraftThreadId(OTHER_PROJECT_ID, OTHER_THREAD_ID);
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "replace this other draft");

      const projectPickerTrigger = page.getByTestId("project-picker-trigger");
      await expect.element(projectPickerTrigger).toHaveTextContent("project");
      const inlineResetButton = page.getByTestId("project-picker-reset-trigger");
      const inlineFolderIcon = projectPickerTrigger
        .element()
        .querySelector<HTMLElement>("[class*='transition-opacity']");
      expect(inlineFolderIcon).not.toBeNull();
      projectPickerTrigger.element().focus();
      await vi.waitFor(() => {
        expect(getComputedStyle(inlineResetButton.element()).opacity).toBe("0");
        expect(getComputedStyle(inlineFolderIcon!).opacity).toBe("1");
      });
      await userEvent.keyboard("{Tab}");
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(inlineResetButton.element());
        expect(getComputedStyle(inlineResetButton.element()).opacity).toBe("1");
        expect(getComputedStyle(inlineFolderIcon!).opacity).toBe("0");
      });
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(projectPickerTrigger.element());
        expect(getComputedStyle(inlineResetButton.element()).opacity).toBe("0");
        expect(getComputedStyle(inlineFolderIcon!).opacity).toBe("1");
      });
      await userEvent.keyboard("{Enter}");

      await expect.element(page.getByText("New project")).toBeInTheDocument();
      await expect.element(page.getByText("Don't work in a project")).toBeInTheDocument();
      await expect.element(page.getByText(/Folders on this/)).not.toBeInTheDocument();
      await page.getByText("New project").hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(inlineResetButton.element()).opacity).toBe("0");
      });

      const currentProjectOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
            (item) => item.textContent?.trim() === "project",
          ) ?? null,
        "Unable to find current project option.",
      );
      currentProjectOption.click();
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: PROJECT_ID,
            envMode: "worktree",
            branch: "feature/keep-out",
            worktreePath: "/repo/project/.worktrees/feature-keep-out",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await projectPickerTrigger.click();
      await page.getByText("other", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: OTHER_PROJECT_ID,
            envMode: "local",
            branch: null,
            worktreePath: null,
          });
          expect(useComposerDraftStore.getState().getDraftThread(OTHER_THREAD_ID)).toBeNull();
          expect(
            useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID],
          ).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("coalesces repeated Studio new-chat clicks and stays in Studio after navigation settles", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [STUDIO_DRAFT_THREAD_ID]: {
          projectId: STUDIO_PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [STUDIO_PROJECT_ID]: STUDIO_DRAFT_THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      // Keep one non-Studio server thread in the snapshot. This matches the real failure: Studio
      // has no persisted chats, while the global missing-thread recovery sees known threads and
      // immediately redirects a transiently-cleared Studio draft to the home index.
      snapshot: withStudioProject(
        withHomeChatProject(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-studio-draft-regression" as MessageId,
            targetText: "projects-side thread",
          }),
        ),
      ),
      initialEntry: `/${STUDIO_DRAFT_THREAD_ID}`,
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
          studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
        };
      },
    });

    try {
      const newStudioChatButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="New studio chat"]'),
        "Unable to find the Studio new-chat action.",
      );
      newStudioChatButton.click();
      newStudioChatButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "A fresh Studio chat should navigate to a new draft UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: STUDIO_PROJECT_ID,
            entryPoint: "chat",
            envMode: "local",
            branch: null,
            worktreePath: null,
            workingDirectory: null,
          });
          expect(document.querySelector('[data-testid="workspace-picker-trigger"]')).not.toBeNull();
          expect(
            useComposerDraftStore.getState().projectDraftThreadIdByProjectId[HOME_PROJECT_ID],
          ).toBeUndefined();
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByTestId("workspace-picker-trigger").click();
      const projectFolderOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
            (item) => item.textContent?.trim() === "project",
          ) ?? null,
        "Unable to find the reference folder option.",
      );
      projectFolderOption.click();
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: STUDIO_PROJECT_ID,
            envMode: "local",
            branch: null,
            worktreePath: null,
            workingDirectory: "/repo/project",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      // A superseded navigation resolves the older navigate() promise before the newer route has
      // committed. Give route effects enough time to expose a late Home redirect, then assert the
      // stable final state and cleanup of the displaced Studio draft.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      await vi.waitFor(
        () => {
          const state = useComposerDraftStore.getState();
          const studioDraftIds = Object.entries(state.draftThreadsByThreadId)
            .filter(([, draft]) => draft.projectId === STUDIO_PROJECT_ID)
            .map(([threadId]) => threadId);
          expect(mounted.router.state.status).toBe("idle");
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(state.getDraftThread(STUDIO_DRAFT_THREAD_ID)).toBeNull();
          expect(studioDraftIds).toEqual([newThreadId]);
          expect(state.projectDraftThreadIdByProjectId[STUDIO_PROJECT_ID]).toBe(newThreadId);
          expect(state.projectDraftThreadIdByProjectId[HOME_PROJECT_ID]).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("can detach an empty project draft back to a normal chat before first send", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withHomeChatProject(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-home-test" as MessageId,
          targetText: "project picker home test",
        }),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
      },
    });

    try {
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      expect(document.activeElement).toBe(composerEditor);
      const projectPickerTrigger = page.getByTestId("project-picker-trigger");
      await expect.element(projectPickerTrigger).toBeInTheDocument();
      const resetProjectButton = page.getByTestId("project-picker-reset-trigger");
      await projectPickerTrigger.hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(resetProjectButton.element()).opacity).toBe("1");
      });

      const originalRequestAnimationFrame = window.requestAnimationFrame;
      let frameRequestCount = 0;
      window.requestAnimationFrame = (callback) => {
        frameRequestCount += 1;
        return originalRequestAnimationFrame(callback);
      };
      try {
        await resetProjectButton.click();
        await vi.waitFor(
          () => {
            expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
              projectId: HOME_PROJECT_ID,
              envMode: "local",
              branch: null,
              worktreePath: null,
            });
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        window.requestAnimationFrame = originalRequestAnimationFrame;
      }

      expect(frameRequestCount).toBe(0);
      expect(document.activeElement).toBe(composerEditor);
      await expect.element(page.getByText("Don't work in a project")).not.toBeInTheDocument();
      await expect.element(page.getByTestId("workspace-picker-trigger")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("moves a home draft into an existing project from the home picker without carrying branch", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: HOME_PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [HOME_PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withStudioProject(withHomeChatProject(createDraftOnlySnapshot())),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
        nextFixture.gitBranchByCwd = {
          "/Users/tester": "home-main",
          "/repo/project": "main",
        };
      },
    });

    try {
      const workspacePickerTrigger = page.getByTestId("workspace-picker-trigger");
      await expect.element(workspacePickerTrigger).toBeInTheDocument();
      const controlsBefore = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] + .chat-composer-shell',
      );
      const composerBlockBefore = document.querySelector<HTMLElement>(
        '[data-empty-landing-composer-block="true"]',
      );
      expect(controlsBefore).not.toBeNull();
      expect(composerBlockBefore).not.toBeNull();
      const beforeRect = controlsBefore!.getBoundingClientRect();
      const composerBlockBeforeRect = composerBlockBefore!.getBoundingClientRect();
      await workspacePickerTrigger.click();

      const projectOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
            (item) => item.textContent?.trim() === "project",
          ) ?? null,
        "Unable to find existing project option.",
      );
      projectOption.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(THREAD_ID)).toMatchObject({
            projectId: PROJECT_ID,
            envMode: "local",
            branch: null,
            worktreePath: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(page.getByTestId("project-picker-trigger")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Local" })).toBeInTheDocument();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const controlsAfter = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] + .chat-composer-shell',
      );
      const composerBlockAfter = document.querySelector<HTMLElement>(
        '[data-empty-landing-composer-block="true"]',
      );
      expect(controlsAfter).not.toBeNull();
      expect(composerBlockAfter).not.toBeNull();
      const afterRect = controlsAfter!.getBoundingClientRect();
      const composerBlockAfterRect = composerBlockAfter!.getBoundingClientRect();
      // Guard against the empty-pane entry animation restarting with a vertical translate
      // when Home selection turns into a project draft.
      expect(
        Math.round(Math.abs(afterRect.height - beforeRect.height)),
        `Composer controls changed height ${beforeRect.height}px -> ${afterRect.height}px`,
      ).toBeLessThanOrEqual(1);
      expect(Math.round(Math.abs(afterRect.top - beforeRect.top))).toBeLessThanOrEqual(1);
      expect(
        Math.round(Math.abs(composerBlockAfterRect.top - composerBlockBeforeRect.top)),
      ).toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates and selects a new project from an empty project draft without navigating away", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-project-picker-new-test" as MessageId,
        targetText: "project picker new test",
      }),
    });
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    const pickFolder = vi.fn(async () => "/repo/new-project");
    let createdProjectId: ProjectId | null = null;
    const dispatchCommand = vi.fn(async (command: unknown) => {
      wsRequests.push({
        _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        command,
      });
      if (recordProjectCreateCommand(command)) {
        if (command && typeof command === "object" && "projectId" in command) {
          createdProjectId = command.projectId as ProjectId;
        }
        return { sequence: fixture.snapshot.snapshotSequence };
      }
      return { sequence: fixture.snapshot.snapshotSequence + 1 };
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        dialogs: {
          ...wsNativeApi?.dialogs,
          pickFolder,
        },
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand,
          getShellSnapshot: vi.fn(async () => createShellSnapshotFromReadModel(fixture.snapshot)),
        },
      },
    });

    try {
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      const projectPickerTrigger = page.getByTestId("project-picker-trigger");
      await expect.element(projectPickerTrigger).toBeInTheDocument();
      await projectPickerTrigger.click();
      await page.getByText("New project").click();
      await vi.waitFor(() => {
        expect(pickFolder).toHaveBeenCalledTimes(1);
      });

      await vi.waitFor(
        () => {
          const projectCreateRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              "command" in request &&
              request.command &&
              typeof request.command === "object" &&
              "type" in request.command &&
              request.command.type === "project.create" &&
              "workspaceRoot" in request.command &&
              request.command.workspaceRoot === "/repo/new-project",
          );
          expect(projectCreateRequest).toBeDefined();
          expect(createdProjectId).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: createdProjectId,
            envMode: "local",
            branch: null,
            worktreePath: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
    } finally {
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("creates a project from the sidebar Create Project dialog and shows it in the sidebar", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-create-project-dialog-test" as MessageId,
        targetText: "create project dialog test",
      }),
    });

    try {
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .toBeInTheDocument();

      await page.getByLabelText("Project folder path").fill("/repo/new-project");
      await page.getByRole("button", { name: "Create project", exact: true }).click();

      await vi.waitFor(
        () => {
          const projectCreateRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              "command" in request &&
              request.command &&
              typeof request.command === "object" &&
              "type" in request.command &&
              request.command.type === "project.create" &&
              "workspaceRoot" in request.command &&
              request.command.workspaceRoot === "/repo/new-project",
          );
          expect(projectCreateRequest).toBeDefined();
        },
        { timeout: 8_000, interval: 16 },
      );

      // The dialog closes on success and the sidebar picks the project up from
      // the refreshed shell snapshot.
      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByText("new-project", { exact: true }).first())
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a Space inline from the Create Project dialog and files the project into it", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-create-project-inline-space" as MessageId,
        targetText: "create project inline space",
      }),
    });

    const findDispatchedCommand = (
      type: string,
      matches: (command: Record<string, unknown>) => boolean,
    ) =>
      wsRequests
        .map(readDispatchedCommand)
        .find((command) => command?.type === type && matches(command));

    try {
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .toBeInTheDocument();

      await page.getByRole("button", { name: "New space", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "New space" })).toBeInTheDocument();
      await page.getByLabelText("Name").fill("Focus");
      await page.getByRole("button", { name: "Create space", exact: true }).click();

      // The nested editor closes, the space.create command is dispatched, and
      // the fresh space is preselected as the project's destination.
      await expect
        .element(page.getByRole("heading", { name: "New space" }))
        .not.toBeInTheDocument();
      let createdSpaceId: unknown;
      await vi.waitFor(
        () => {
          const spaceCreateCommand = findDispatchedCommand(
            "space.create",
            (command) => command.name === "Focus",
          );
          expect(spaceCreateCommand).toBeDefined();
          createdSpaceId = spaceCreateCommand?.spaceId;
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(page.getByText("Focus", { exact: true }).first()).toBeInTheDocument();

      await page.getByLabelText("Project folder path").fill("/repo/spaced-project");
      await page.getByRole("button", { name: "Create project", exact: true }).click();

      await vi.waitFor(
        () => {
          const projectCreateCommand = findDispatchedCommand(
            "project.create",
            (command) => command.workspaceRoot === "/repo/spaced-project",
          );
          expect(projectCreateCommand).toBeDefined();
          expect(projectCreateCommand?.spaceId).toBe(createdSpaceId);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("rolls back the provisional Space when project creation fails", async () => {
    const currentSpaceId = SpaceId.makeUnsafe("space-current");
    const destinationSpaceId = SpaceId.makeUnsafe("space-destination");
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-create-project-space-rollback" as MessageId,
      targetText: "create project space rollback",
    });
    useSpacesUiStore.getState().setActiveSpaceId(currentSpaceId);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        spaces: [
          {
            id: currentSpaceId,
            name: "Current",
            icon: "bag",
            sortOrder: 0,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            deletedAt: null,
          },
          {
            id: destinationSpaceId,
            name: "Destination",
            icon: "target",
            sortOrder: 1,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            deletedAt: null,
          },
        ],
        projects: baseSnapshot.projects.map((project) => ({
          ...project,
          spaceId: currentSpaceId,
        })),
      },
    });
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand: vi.fn(async () => {
            throw new Error("Project creation failed for test.");
          }),
        },
      },
    });

    try {
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      await page.getByLabelText("Project folder path").fill("/repo/failing-project");
      const spaceTrigger = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-slot="dialog-popup"] [data-slot="select-trigger"]',
          ),
        "Unable to find the Create Project Space selector.",
      );
      spaceTrigger.click();
      const destinationOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')).find(
            (item) => item.textContent?.trim() === "Destination",
          ) ?? null,
        "Unable to find the destination Space option.",
      );
      destinationOption.click();
      await page.getByRole("button", { name: "Create project", exact: true }).click();

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Project creation failed for test.");
      expect(useSpacesUiStore.getState().activeSpaceId).toBe(currentSpaceId);
      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .toBeInTheDocument();
    } finally {
      useSpacesUiStore.getState().setActiveSpaceId(null);
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("snapshots sticky codex settings into a new draft thread", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-codex-traits-test" as MessageId,
        targetText: "sticky codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers New worktree from an empty draft thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-empty-worktree-test" as MessageId,
        targetText: "empty worktree test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      const envPickerTrigger = await waitForEnvironmentModeButton("Local");
      envPickerTrigger.click();

      const newWorktreeOption = page.getByText("New worktree");
      await expect.element(newWorktreeOption).toBeInTheDocument();
      await newWorktreeOption.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.envMode).toBe(
            "worktree",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a detached worktree on first send in New worktree mode", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-worktree-send-test" as MessageId,
        targetText: "new worktree send test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      const envPickerTrigger = await waitForEnvironmentModeButton("Local");
      envPickerTrigger.click();

      const newWorktreeOption = page.getByText("New worktree");
      await expect.element(newWorktreeOption).toBeInTheDocument();
      await newWorktreeOption.click();

      useComposerDraftStore.getState().setPrompt(newThreadId, "Ship it");
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            envMode: "worktree",
            branch: "main",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("Ship it");
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await vi.waitFor(
        () => {
          const createWorktreeRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.gitCreateDetachedWorktree &&
              request.cwd === "/repo/project" &&
              request.ref === "main" &&
              request.copyChangesFrom === "/repo/project",
          );
          expect(createWorktreeRequest).toBeTruthy();

          const createThreadRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              "threadId" in request.command &&
              request.command.type === "thread.create" &&
              request.command.threadId === newThreadId,
          );
          expect(createThreadRequest).toBeTruthy();
          expect(createThreadRequest?.command).toMatchObject({
            envMode: "worktree",
            branch: null,
            worktreePath: "/repo/.codex/worktrees/generated/synara",
            associatedWorktreePath: "/repo/.codex/worktrees/generated/synara",
            associatedWorktreeBranch: null,
            associatedWorktreeRef: "0123456789abcdef0123456789abcdef01234567",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("runs the setup action from the newly-created worktree before starting the turn", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(
        withStudioProject(
          withHomeChatProject(
            createSnapshotForTargetUser({
              targetMessageId: "msg-user-new-worktree-setup-action-test" as MessageId,
              targetText: "new worktree setup action test",
            }),
          ),
        ),
        [
          {
            id: "setup",
            name: "Setup",
            command: "printf setup",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
      ),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      const envPickerTrigger = await waitForEnvironmentModeButton("Local");
      envPickerTrigger.click();

      const newWorktreeOption = page.getByText("New worktree");
      await expect.element(newWorktreeOption).toBeInTheDocument();
      await newWorktreeOption.click();

      useComposerDraftStore.getState().setPrompt(newThreadId, "Ship it with setup");
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            envMode: "worktree",
            branch: "main",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("Ship it with setup");
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      const composerForm = document.querySelector<HTMLFormElement>(
        'form[data-chat-composer-form="true"]',
      );
      expect(composerForm).not.toBeNull();
      composerForm!.requestSubmit();

      const createWorktreeRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.gitCreateDetachedWorktree &&
              candidate.cwd === "/repo/project" &&
              candidate.ref === "main",
          );
          expect(
            request,
            `Expected create worktree request; draft=${JSON.stringify(
              useComposerDraftStore.getState().getDraftThread(newThreadId),
            )}; path=${mounted.router.state.location.pathname}; forms=${
              document.querySelectorAll('form[data-chat-composer-form="true"]').length
            }; ui=${(document.body.textContent ?? "").slice(-300)}; saw ${wsRequests
              .map((candidate) => {
                const command = readDispatchedCommand(candidate);
                return command ? `${candidate._tag}:${command.type}` : candidate._tag;
              })
              .slice(-40)
              .join(", ")}`,
          ).toBeTruthy();
          if (!request || request._tag !== WS_METHODS.gitCreateDetachedWorktree) {
            throw new Error("Expected create worktree request.");
          }
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const createWorktreeIndex = wsRequests.indexOf(createWorktreeRequest);
      const worktreePath = "/repo/.codex/worktrees/generated/synara";

      const terminalOpenRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.terminalOpen &&
              candidate.threadId === newThreadId &&
              candidate.cwd === worktreePath,
          );
          expect(
            request,
            `Expected setup terminal open; saw ${wsRequests
              .map((candidate) => {
                const command = readDispatchedCommand(candidate);
                return command ? `${candidate._tag}:${command.type}` : candidate._tag;
              })
              .join(", ")}`,
          ).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const terminalOpenIndex = wsRequests.indexOf(terminalOpenRequest!);
      expect(terminalOpenIndex).toBeGreaterThan(createWorktreeIndex);
      expect(terminalOpenRequest).toMatchObject({
        _tag: WS_METHODS.terminalOpen,
        cwd: worktreePath,
        env: {
          SYNARA_PROJECT_ROOT: "/repo/project",
          SYNARA_WORKTREE_PATH: worktreePath,
        },
      });

      const terminalWriteRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.terminalWrite &&
              candidate.threadId === newThreadId &&
              candidate.data === "printf setup\r",
          );
          expect(request).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const terminalWriteIndex = wsRequests.indexOf(terminalWriteRequest!);
      expect(terminalWriteIndex).toBeGreaterThan(terminalOpenIndex);

      const turnStartRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find((candidate) => {
            const command = readDispatchedCommand(candidate);
            return command?.type === "thread.turn.start" && command.threadId === newThreadId;
          });
          expect(request).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      expect(wsRequests.indexOf(turnStartRequest!)).toBeGreaterThan(terminalWriteIndex);
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("hydrates the provider alongside a sticky claude model", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "claudeAgent",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
        targetText: "sticky claude model test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new sticky claude draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: {
              effort: "max",
              fastMode: true,
            },
          },
        },
        activeProvider: "claudeAgent",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to defaults when no sticky composer settings exist", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
        targetText: "default codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toBeUndefined();
    } finally {
      await mounted.cleanup();
    }
  });

  it("reuses the existing draft thread when the user clicks new thread again", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
        targetText: "draft codex traits precedence test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const threadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a sticky draft thread UUID.",
      );
      const threadId = threadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(threadId, {
        provider: "codex",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "low",
          fastMode: true,
        },
      });
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
            modelSelectionByProvider: {
              codex: {
                provider: "codex",
                model: "gpt-5.4",
                options: {
                  reasoningEffort: "low",
                  fastMode: true,
                },
              },
            },
            activeProvider: "codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await newThreadButton.click();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 64);
      });

      expect(mounted.router.state.location.pathname).toBe(threadPath);
      expect(useComposerDraftStore.getState().projectDraftThreadIdByProjectId[PROJECT_ID]).toBe(
        threadId,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes terminal-first shortcut threads so they render as terminal rows", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-shortcut-test" as MessageId,
        targetText: "terminal shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newTerminal",
              shortcut: {
                key: "t",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const newThreadPath = await triggerTerminalThreadShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new terminal-first draft thread UUID from the shortcut.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                typeof request.command === "object" &&
                request.command !== null &&
                "type" in request.command &&
                "threadId" in request.command &&
                request.command.type === "thread.create" &&
                request.command.threadId === newThreadId,
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      useStore.getState().syncServerReadModel(addThreadToSnapshot(fixture.snapshot, newThreadId));
      useComposerDraftStore.getState().clearDraftThread(newThreadId);

      await vi.waitFor(
        () => {
          const terminalThreadRow = document.querySelector<HTMLElement>(
            '[data-thread-entry-point="terminal"]',
          );
          expect(terminalThreadRow).not.toBeNull();
          expect(terminalThreadRow?.textContent).toContain("New thread");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("promotes a stored terminal draft using its saved context and model selection", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const draftThreadId = ThreadId.makeUnsafe("thread-terminal-draft-reuse");
    useComposerDraftStore.setState({
      draftsByThreadId: {
        [draftThreadId]: {
          prompt: "",
          promptHistorySavedDraft: null,
          images: [],
          files: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
          assistantSelections: [],
          browserAnnotations: [],
          terminalContexts: [],
          fileComments: [],
          pastedTexts: [],
          skills: [],
          mentions: [],
          queuedTurns: [],
          modelSelectionByProvider: {
            claudeAgent: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                effort: "max",
              },
            },
          },
          activeProvider: "claudeAgent",
          runtimeMode: null,
          interactionMode: null,
        },
      },
      draftThreadsByThreadId: {
        [draftThreadId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "approval-required",
          interactionMode: "default",
          entryPoint: "terminal",
          branch: "feature/terminal-title",
          worktreePath: "/repo/project/.worktrees/terminal-title",
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: {
        [`${PROJECT_ID}::terminal`]: draftThreadId,
      },
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-draft-reuse-test" as MessageId,
        targetText: "terminal draft reuse test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newTerminal",
              shortcut: {
                key: "t",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      dispatchTerminalThreadShortcut();

      await waitForURL(
        mounted.router,
        (path) => path === `/${draftThreadId}`,
        "Shortcut should reuse the stored terminal draft thread route.",
      );

      await vi.waitFor(
        () => {
          const createRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              "threadId" in request.command &&
              request.command.type === "thread.create" &&
              request.command.threadId === draftThreadId,
          );

          expect(createRequest).toBeTruthy();
          expect(createRequest?.command).toMatchObject({
            branch: "feature/terminal-title",
            worktreePath: "/repo/project/.worktrees/terminal-title",
            runtimeMode: "approval-required",
            modelSelection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                effort: "max",
              },
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("enables plan mode from the composer extras menu", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-plan-mode-toggle-test" as MessageId,
        targetText: "plan mode toggle test",
      }),
    });

    try {
      await page.getByLabelText("Composer extras").click();
      await page.getByText("Plan mode").click();

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode).toBe(
          "plan",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("distinguishes plan mode from the plan details sidebar button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledPlanAwaitingFollowUp(),
    });

    try {
      await waitForServerConfigToApply();
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );

      await vi.waitFor(() => {
        const buttonLabels = Array.from(footer.querySelectorAll("button"))
          .map((button) => button.textContent?.trim() ?? "")
          .filter(Boolean);

        expect(buttonLabels.filter((label) => label === "Plan")).toHaveLength(1);
        expect(buttonLabels).toContain("Plan details");
        expect(document.querySelector('button[title="Show plan sidebar"]')).toBeNull();
      });
      await expect
        .element(page.getByTitle("Plan mode — click to return to normal build mode"))
        .toBeInTheDocument();
      await expect.element(page.getByLabelText("Show plan details sidebar")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      await newThreadButton.click();

      const promotedThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a promoted draft thread UUID.",
      );
      const promotedThreadId = promotedThreadPath.slice(1) as ThreadId;

      const { syncServerReadModel } = useStore.getState();
      syncServerReadModel(addThreadToSnapshot(fixture.snapshot, promotedThreadId));
      useComposerDraftStore.getState().clearDraftThread(promotedThreadId);

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");

      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps proposed plans inline until execution starts", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await expect.element(page.getByText("Expand plan")).toBeInTheDocument();
      expect(document.querySelector('[aria-label="Close plan sidebar"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the final transcript row clear of a tall composer panel stack", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithTallComposerStack(),
    });

    const maxFixedClearancePx = 128;

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("2 files changed");
          expect(document.body.textContent).toContain("1 out of 3 tasks completed");
        },
        { timeout: 8_000, interval: 16 },
      );

      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const readStackLayout = () => {
        const renderedRows = Array.from(
          document.querySelectorAll<HTMLElement>("[data-timeline-row-kind]"),
        );
        const finalTranscriptRow = renderedRows.reduce<HTMLElement | null>((latest, row) => {
          if (!latest) return row;
          return row.getBoundingClientRect().bottom > latest.getBoundingClientRect().bottom
            ? row
            : latest;
        }, null);
        const taskListCard = document.querySelector<HTMLElement>(
          '[data-testid="active-task-list-card"]',
        );
        const stackedPanels = taskListCard?.parentElement ?? null;

        expect(
          finalTranscriptRow,
          "Unable to find the final rendered transcript row.",
        ).toBeTruthy();
        expect(taskListCard, "Unable to find the active task-list card.").toBeTruthy();
        expect(stackedPanels, "Unable to find the stacked composer-panel wrapper.").toBeTruthy();

        const finalRowRect = finalTranscriptRow!.getBoundingClientRect();
        const taskCardRect = taskListCard!.getBoundingClientRect();
        const stackRect = stackedPanels!.getBoundingClientRect();
        return {
          gapPx: stackRect.top - finalRowRect.bottom,
          stackHeightPx: stackRect.height,
          taskCardHeightPx: taskCardRect.height,
          distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
        };
      };

      const waitForBoundedGap = async (phase: string) => {
        let measured = readStackLayout();
        await vi.waitFor(
          () => {
            measured = readStackLayout();
            expect(
              measured.distanceFromBottomPx,
              `${phase}: transcript must stay at the end`,
            ).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
            expect(
              measured.gapPx,
              `${phase}: final row must not be obscured`,
            ).toBeGreaterThanOrEqual(-1);
            expect(
              measured.gapPx,
              `${phase}: gap must stay within fixed clearance`,
            ).toBeLessThanOrEqual(maxFixedClearancePx);
          },
          { timeout: 4_000, interval: 16 },
        );
        return measured;
      };

      const expanded = await waitForBoundedGap("expanded");
      expect(expanded.stackHeightPx).toBeGreaterThan(maxFixedClearancePx);

      const collapseButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Collapse task banner"]'),
        "Unable to find the task-banner collapse button.",
      );
      collapseButton.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLButtonElement>('button[aria-label="Expand task banner"]'),
        ).not.toBeNull();
      });
      const collapsed = await waitForBoundedGap("collapsed");
      expect(collapsed.taskCardHeightPx).toBeLessThan(expanded.taskCardHeightPx - 20);
      expect(Math.abs(collapsed.gapPx - expanded.gapPx)).toBeLessThanOrEqual(8);

      const expandButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Expand task banner"]'),
        "Unable to find the task-banner expand button.",
      );
      expandButton.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLButtonElement>('button[aria-label="Collapse task banner"]'),
        ).not.toBeNull();
      });
      const reexpanded = await waitForBoundedGap("re-expanded");
      expect(reexpanded.taskCardHeightPx).toBeGreaterThan(collapsed.taskCardHeightPx + 20);
      expect(Math.abs(reexpanded.gapPx - expanded.gapPx)).toBeLessThanOrEqual(8);

      const finalCollapseButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Collapse task banner"]'),
        "Unable to find the task-banner collapse button before the away-from-end check.",
      );
      finalCollapseButton.click();
      const finalExpandButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Expand task banner"]'),
        "Unable to find the task-banner expand button before the away-from-end check.",
      );
      await vi.waitFor(() => {
        expect(readStackLayout().taskCardHeightPx).toBeLessThan(expanded.taskCardHeightPx - 20);
      });

      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await vi.waitFor(() => {
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      const scrollTopBeforeExpansion = scrollContainer.scrollTop;

      finalExpandButton.click();
      await vi.waitFor(
        () => {
          const awayFromEnd = readStackLayout();
          expect(awayFromEnd.taskCardHeightPx).toBeGreaterThan(expanded.taskCardHeightPx - 2);
        },
        { timeout: 4_000, interval: 16 },
      );
      await waitForLayout();
      expect(readStackLayout().distanceFromBottomPx).toBeGreaterThan(
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );
      await waitForLayout();
      expect(readStackLayout().distanceFromBottomPx).toBeGreaterThan(
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );
      expect(Math.abs(scrollContainer.scrollTop - scrollTopBeforeExpansion)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the skinny inline plan card for active turn plans", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("1 out of 3 tasks completed");
          expect(document.body.textContent).toContain("Inspecting ChatView boundaries");
          expect(document.body.textContent).toContain("Patch the shared checklist receiver");
          expect(document.body.textContent).toContain("1 background agent");
        },
        { timeout: 8_000, interval: 16 },
      );

      const transcriptPane = document.querySelector<HTMLElement>("[data-chat-transcript-pane]");
      const taskListCard = document.querySelector<HTMLElement>(
        '[data-testid="active-task-list-card"]',
      );
      const composerShell = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] .chat-composer-shell',
      );
      expect(transcriptPane).not.toBeNull();
      expect(taskListCard).not.toBeNull();
      expect(composerShell).not.toBeNull();
      expect(transcriptPane!.getBoundingClientRect().bottom).toBeGreaterThan(
        taskListCard!.getBoundingClientRect().top + 1,
      );
      // Active plan activity shares the centered queued-follow-up rail, intentionally inset to
      // eleven twelfths of the composer width while the input keeps its rounded top corners.
      const taskRect = taskListCard!.getBoundingClientRect();
      const composerRect = composerShell!.getBoundingClientRect();
      expect(Math.abs(taskRect.width - (composerRect.width * 11) / 12)).toBeLessThanOrEqual(2);
      expect(
        Math.abs(taskRect.left + taskRect.width / 2 - (composerRect.left + composerRect.width / 2)),
      ).toBeLessThanOrEqual(1);
      expect(parseFloat(getComputedStyle(composerShell!).borderTopLeftRadius)).toBeGreaterThan(0);

      const openPlanButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title="Open tasks sidebar"]'),
        "Unable to find inline active plan sidebar button.",
      );
      openPlanButton.click();

      await expect.element(page.getByLabelText("Close plan sidebar")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides an unfinished task list once the latest turn is settled", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Finished the investigation.");
          expect(document.body.textContent).not.toContain("1 out of 3 tasks completed");
          expect(document.querySelector('[data-testid="active-task-list-card"]')).toBeNull();
          expect(document.body.textContent).not.toContain("1 background agent");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides a completed task list once the latest turn is settled", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledCompletedInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Finished the investigation.");
          expect(document.body.textContent).not.toContain("3 out of 3 tasks completed");
          expect(document.querySelector('[data-testid="active-task-list-card"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the stop button once a completed turn is no longer live", async () => {
    const settledSnapshot = createSnapshotWithSettledInlinePlan();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...settledSnapshot,
        threads: settledSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.role === "assistant"
                    ? {
                        ...message,
                        streaming: true,
                      }
                    : message,
                ),
              }
            : thread,
        ),
      },
    });

    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses a settled leading tool run mid-turn, then folds into Worked for after the grace delay", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: true }),
    });

    try {
      // The tools already gave way to the assistant's narration block, so even
      // while the turn is live the run compacts behind its summary row.
      await vi.waitFor(
        () => {
          const summaryTrigger = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
          ).find((element) => element.textContent?.includes("Used 6 tools"));
          expect(summaryTrigger).not.toBeUndefined();
          expect(summaryTrigger!.getAttribute("aria-expanded")).toBe("false");
          expect(document.body.textContent).not.toContain("Tool 1");
        },
        { timeout: 8_000, interval: 16 },
      );

      const settledSnapshot = createSnapshotWithInlineToolOverflow({ active: false });
      useStore.getState().syncServerReadModel({
        ...settledSnapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      });

      // The first settled paint keeps the live layout: no "Worked for" fold yet.
      expect(document.querySelector("[data-settled-turn-collapse-transition='true']")).toBeNull();
      expect(document.body.textContent).toContain("Used 6 tools");

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 260);
      });

      // Once the grace delay lapses the settled turn folds into "Worked for…",
      // but the old details stay mounted briefly inside the shared disclosure
      // close transition so the transcript height eases down instead of snapping.
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Worked for");
          const transitionClone = document.querySelector(
            "[data-settled-turn-collapse-transition='true']",
          );
          expect(transitionClone).not.toBeNull();
          expect(transitionClone?.hasAttribute("inert")).toBe(true);
          expect(transitionClone?.querySelector("[aria-hidden='true'][inert]")).not.toBeNull();
          expect(transitionClone?.textContent).toContain("Used 6 tools");
        },
        { timeout: 8_000, interval: 16 },
      );

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 320);
      });

      // After the close motion finishes, details are only available by opening
      // the "Worked for…" disclosure.
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("[data-settled-turn-collapse-transition='true']"),
          ).toBeNull();
          expect(document.body.textContent).not.toContain("Tool 1");
          const settledTrigger = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button"),
          ).find((element) => element.textContent?.includes("Worked for"));
          if (settledTrigger) {
            expect(settledTrigger.getAttribute("aria-expanded")).toBe("false");
          }
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
