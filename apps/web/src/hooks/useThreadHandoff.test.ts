// FILE: useThreadHandoff.test.ts
// Purpose: Verifies handoff target guards run before provider or orchestration side effects.
// Layer: Web hook tests

import {
  DEFAULT_PROVIDER_PROFILE_ID,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSlug,
} from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyTransferableComposerState: vi.fn(),
  dispatchCommand: vi.fn(),
  getShellSnapshot: vi.fn(),
  navigate: vi.fn(),
  refreshProviderStatuses: vi.fn(),
  syncServerShellSnapshot: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
}));

vi.mock("../lib/serverReactQuery", () => ({
  serverSettingsQueryOptions: () => ({}),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => undefined, {
    getState: () => ({
      copyTransferableComposerState: mocks.copyTransferableComposerState,
      stickyModelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          profileId: "work",
          model: "claude-opus-4-1",
        },
      },
    }),
  });
  return { useComposerDraftStore };
});

vi.mock("./useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => [],
}));

vi.mock("./useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => mocks.refreshProviderStatuses,
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: mocks.dispatchCommand,
      getShellSnapshot: mocks.getShellSnapshot,
    },
  }),
}));

const PROJECT_ID = ProjectId.makeUnsafe("project-handoff-profile");
const THREAD_ID = ThreadId.makeUnsafe("thread-handoff-profile");

vi.mock("../store", () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      projects: [
        {
          id: "project-handoff-profile",
          defaultModelSelection: null,
        },
      ],
      syncServerShellSnapshot: mocks.syncServerShellSnapshot,
    }),
}));

import { useThreadHandoff } from "./useThreadHandoff";
import type { Thread } from "../types";

const SOURCE_THREAD = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  modelSelection: {
    provider: "codex",
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
    model: "gpt-5.6-sol" as ModelSlug,
  },
  session: null,
  handoff: null,
  messages: [
    {
      id: MessageId.makeUnsafe("message-handoff-profile"),
      role: "user",
      text: "Continue this work",
      source: "native",
      streaming: false,
      createdAt: "2026-08-10T12:00:00.000Z",
    },
  ],
} as unknown as Thread;

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});

describe("useThreadHandoff provider profile guard", () => {
  it("rejects an unsupported target before refresh, dispatch, copy, snapshot, or navigation", async () => {
    const { createThreadHandoff } = useThreadHandoff();

    await expect(createThreadHandoff(SOURCE_THREAD, "claudeAgent")).rejects.toThrow(
      "Provider profile 'work' is not configured for provider 'claudeAgent'.",
    );

    expect(mocks.refreshProviderStatuses).not.toHaveBeenCalled();
    expect(mocks.dispatchCommand).not.toHaveBeenCalled();
    expect(mocks.copyTransferableComposerState).not.toHaveBeenCalled();
    expect(mocks.getShellSnapshot).not.toHaveBeenCalled();
    expect(mocks.syncServerShellSnapshot).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
