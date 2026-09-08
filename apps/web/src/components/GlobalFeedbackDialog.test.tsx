// FILE: GlobalFeedbackDialog.test.tsx

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "~/types";

const mocks = vi.hoisted(() => ({
  focusedChat: {
    activeProject: null as Project | null,
    activeProjectId: null as Project["id"] | null,
    activeThread: null as unknown,
  },
  projects: [] as Project[],
  handleNewThread: vi.fn(),
  appendComposerPromptText: vi.fn(),
  toastAdd: vi.fn(),
  dialogProps: { current: null as Record<string, unknown> | null },
}));

vi.mock("../focusedChatContext", () => ({
  useFocusedChatContext: () => mocks.focusedChat,
}));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    handleNewThread: mocks.handleNewThread,
    projects: mocks.projects,
  }),
}));
vi.mock("../workspacePathsStore", () => ({
  useWorkspacePathsStore: (
    selector: (store: {
      homeDir: string;
      chatWorkspaceRoot: string;
      studioWorkspaceRoot: string;
    }) => unknown,
  ) =>
    selector({
      homeDir: "/home/tester",
      chatWorkspaceRoot: "/home/tester/.synara/chats",
      studioWorkspaceRoot: "/home/tester/.synara/studio",
    }),
}));
vi.mock("../lib/chatReferences", () => ({
  appendComposerPromptText: mocks.appendComposerPromptText,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.toastAdd },
}));
vi.mock("./FeedbackDialog", () => ({
  FeedbackDialog: (props: Record<string, unknown>) => {
    mocks.dialogProps.current = props;
    return null;
  },
}));

import { useFeedbackDialogStore } from "../feedbackDialogStore";
import { GlobalFeedbackDialog } from "./GlobalFeedbackDialog";

function project(partial: Partial<Project> & { id: Project["id"] }): Project {
  return {
    kind: "project",
    name: partial.id,
    remoteName: partial.id,
    folderName: partial.id,
    localName: null,
    cwd: `/repo/${partial.id}`,
    defaultModelSelection: null,
    expanded: false,
    scripts: [],
    ...partial,
  } as Project;
}

const HOME_CONTAINER = project({
  id: "home" as Project["id"],
  kind: "chat",
  name: "Home",
  remoteName: "Home",
  cwd: "/home/tester",
});

function renderDialog(): Record<string, unknown> {
  renderToStaticMarkup(<GlobalFeedbackDialog />);
  const props = mocks.dialogProps.current;
  if (!props) throw new Error("FeedbackDialog was not rendered");
  return props;
}

describe("GlobalFeedbackDialog.onDraftGithubIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dialogProps.current = null;
    mocks.focusedChat.activeProject = null;
    mocks.focusedChat.activeProjectId = null;
    mocks.focusedChat.activeThread = null;
    mocks.projects = [];
    mocks.handleNewThread.mockResolvedValue("thread-1");
    useFeedbackDialogStore.setState({ isOpen: false, context: null, initialCategory: null });
    vi.stubGlobal("window", { innerWidth: 1_440, innerHeight: 900 });
    vi.stubGlobal("navigator", {
      userAgent: "Synara test agent",
      platform: "MacIntel",
      language: "en-US",
    });
  });

  it("mints a thread in the active ordinary project and fills the sanitized prompt", async () => {
    const ordinary = project({ id: "proj-active" as Project["id"] });
    mocks.projects = [HOME_CONTAINER, ordinary];
    mocks.focusedChat.activeProject = ordinary;
    mocks.focusedChat.activeProjectId = ordinary.id;
    useFeedbackDialogStore.getState().openDialog(undefined, "bug");

    const props = renderDialog();
    const draft = props.onDraftGithubIssue as (details: string) => Promise<void>;
    await draft("Send crashes. My key is ghp_0123456789abcdefghijklmnop");

    expect(mocks.handleNewThread).toHaveBeenCalledWith(ordinary.id, { fresh: true });
    expect(mocks.appendComposerPromptText).toHaveBeenCalledTimes(1);
    const [threadId, prompt] = mocks.appendComposerPromptText.mock.calls[0] as [string, string];
    expect(threadId).toBe("thread-1");
    expect(prompt).toContain("bug report");
    expect(prompt).toContain("[REDACTED]");
    expect(prompt).not.toContain("ghp_0123456789abcdefghijklmnop");
    expect(useFeedbackDialogStore.getState().isOpen).toBe(false);
    expect(mocks.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("drafts into the first ordinary project when the active container is Home", async () => {
    const ordinary = project({ id: "proj-first" as Project["id"] });
    mocks.projects = [HOME_CONTAINER, ordinary];
    mocks.focusedChat.activeProject = HOME_CONTAINER;
    mocks.focusedChat.activeProjectId = HOME_CONTAINER.id;

    const props = renderDialog();
    const draft = props.onDraftGithubIssue as (details: string) => Promise<void>;
    await draft("Sidebar collapsed and never came back.");

    expect(mocks.handleNewThread).toHaveBeenCalledWith(ordinary.id, { fresh: true });
  });

  it("hides the draft action when no ordinary project exists", () => {
    mocks.projects = [HOME_CONTAINER];
    mocks.focusedChat.activeProject = HOME_CONTAINER;
    mocks.focusedChat.activeProjectId = HOME_CONTAINER.id;

    const props = renderDialog();

    expect(props.onDraftGithubIssue).toBeUndefined();
  });

  it("rejects without touching the composer when the thread cannot be opened", async () => {
    const ordinary = project({ id: "proj-only" as Project["id"] });
    mocks.projects = [ordinary];
    mocks.handleNewThread.mockResolvedValue(null);
    useFeedbackDialogStore.getState().openDialog(undefined, "bug");

    const props = renderDialog();
    const draft = props.onDraftGithubIssue as (details: string) => Promise<void>;

    await expect(draft("anything")).rejects.toThrow("Could not open a draft thread.");
    expect(mocks.appendComposerPromptText).not.toHaveBeenCalled();
    // The dialog stays open so the report details are not lost on failure.
    expect(useFeedbackDialogStore.getState().isOpen).toBe(true);
  });
});
