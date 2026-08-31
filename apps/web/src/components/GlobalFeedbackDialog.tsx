import { buildFeedbackSubmission } from "../feedback";
import type { FeedbackThreadContext } from "../feedback";
import { buildBugReportDiagnostics, buildGithubIssueInterviewPrompt } from "../feedbackGithubIssue";
import { useFeedbackDialogStore } from "../feedbackDialogStore";
import { useFocusedChatContext } from "../focusedChatContext";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { appendComposerPromptText } from "../lib/chatReferences";
import { FeedbackDialog } from "./FeedbackDialog";
import { toastManager } from "./ui/toast";

export function GlobalFeedbackDialog() {
  const { activeProject, activeProjectId, activeThread } = useFocusedChatContext();
  const isOpen = useFeedbackDialogStore((state) => state.isOpen);
  const requestedContext = useFeedbackDialogStore((state) => state.context);
  const requestedInitialCategory = useFeedbackDialogStore((state) => state.initialCategory);
  const setOpen = useFeedbackDialogStore((state) => state.setOpen);

  const { handleNewThread, projects } = useHandleNewThread();
  const hasProjects = projects.length > 0;

  const context: FeedbackThreadContext = requestedContext ?? {
    provider: activeThread?.modelSelection.provider ?? null,
    model: activeThread?.modelSelection.model ?? null,
    projectKind: activeProject?.kind ?? null,
    environmentMode: activeThread?.envMode ?? null,
    runtimeMode: activeThread?.runtimeMode ?? null,
    interactionMode: activeThread?.interactionMode ?? null,
    sessionStatus: activeThread?.session?.status ?? null,
    latestTurnState: activeThread?.latestTurn?.state ?? null,
    messageCount: activeThread?.messages.length ?? 0,
    activityCount: activeThread?.activities.length ?? 0,
    hasPendingApproval: activeThread?.hasPendingApprovals === true,
    hasPendingUserInput: activeThread?.hasPendingUserInput === true,
    hasThreadError: Boolean(activeThread?.error),
  };

  const onDraftGithubIssue = async (details: string) => {
    const projectId = activeProjectId ?? projects[0]?.id ?? null;
    if (!projectId) {
      throw new Error("No project available.");
    }

    const submission = buildFeedbackSubmission({ category: "bug", details, context });
    const prompt = buildGithubIssueInterviewPrompt({
      details: submission.details,
      diagnosticsSummary: buildBugReportDiagnostics(submission.diagnostics),
    });

    const threadId = await handleNewThread(projectId, { fresh: true });
    if (!threadId) {
      throw new Error("Could not open a draft thread.");
    }

    appendComposerPromptText(threadId, prompt);
    setOpen(false);
    toastManager.add({
      type: "success",
      title: "Bug-report thread ready",
      description: "Review the prompt and send it.",
    });
  };

  return (
    <FeedbackDialog
      open={isOpen}
      context={context}
      initialCategory={requestedInitialCategory}
      onOpenChange={setOpen}
      onDraftGithubIssue={hasProjects ? onDraftGithubIssue : undefined}
    />
  );
}
