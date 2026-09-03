import { type MessageId, type ThreadId } from "@synara/contracts";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  scheduleFromForm,
  type AutomationFormState,
  useAutomations,
} from "../../routes/-automations.shared";
import {
  buildAutomationDraftWarnings,
  updateAutomationDraftWarningAcknowledgement,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "../../lib/automationDraft";
import { createAllThreadsSelector } from "../../storeSelectors";
import { useStore } from "../../store";
import type { ChatMessage } from "../../types";

export interface PendingAutomationConversation {
  readonly threadId: ThreadId;
  readonly accumulatedMessage: string;
  readonly bubbles: ChatMessage[];
}

export interface AutomationDraftWarningContext {
  readonly hasEphemeralContext: boolean;
  readonly generatedConfidence: number | null;
  readonly generatedNeedsConfirmation: boolean;
}

interface UseChatAutomationSetupInput {
  readonly threadId: ThreadId;
  readonly hasLiveTurn: boolean;
  readonly promptRef: MutableRefObject<string>;
  readonly setComposerDraftPrompt: (threadId: ThreadId, prompt: string) => void;
}

const EMPTY_WARNING_CONTEXT: AutomationDraftWarningContext = {
  hasEphemeralContext: false,
  generatedConfidence: null,
  generatedNeedsConfirmation: false,
};

const selectAllThreads = createAllThreadsSelector();

export function useChatAutomationSetup({
  threadId,
  hasLiveTurn,
  promptRef,
  setComposerDraftPrompt,
}: UseChatAutomationSetupInput) {
  const automationProjects = useStore((state) => state.projects);
  const automationThreads = useStore(selectAllThreads);
  const { data: automationData, updateMutation: automationUpdateMutation } = useAutomations();
  const [automationDraftForm, setAutomationDraftForm] = useState<AutomationFormState | null>(null);
  const [automationDraftWarnings, setAutomationDraftWarnings] = useState<
    readonly AutomationDraftWarning[]
  >([]);
  const [automationDraftWarningContext, setAutomationDraftWarningContext] =
    useState<AutomationDraftWarningContext>(EMPTY_WARNING_CONTEXT);
  const [acknowledgedAutomationWarnings, setAcknowledgedAutomationWarnings] = useState<
    ReadonlySet<AutomationDraftWarningId>
  >(() => new Set());
  const [automationDraftOpen, setAutomationDraftOpen] = useState(false);
  const [isAutomationDraftSubmitting, setIsAutomationDraftSubmitting] = useState(false);
  const automationDraftSubmittingRef = useRef(false);
  const [pendingAutomationConversation, setPendingAutomationConversation] =
    useState<PendingAutomationConversation | null>(null);
  const activeThreadIdRef = useRef(threadId);
  const pendingAutomationConversationRef = useRef(pendingAutomationConversation);
  const hasLiveTurnRef = useRef(hasLiveTurn);

  useLayoutEffect(() => {
    activeThreadIdRef.current = threadId;
    pendingAutomationConversationRef.current = pendingAutomationConversation;
    hasLiveTurnRef.current = hasLiveTurn;
  }, [hasLiveTurn, pendingAutomationConversation, threadId]);

  const isPendingSetupBubbleId = useCallback(
    (messageId: MessageId): boolean =>
      pendingAutomationConversationRef.current?.bubbles.some((bubble) => bubble.id === messageId) ??
      false,
    [],
  );
  const restorePendingAutomationConversationDraft = useCallback(
    (conversation: PendingAutomationConversation) => {
      const draft = promptRef.current.trim();
      const restored = draft
        ? `${conversation.accumulatedMessage}\n${draft}`
        : conversation.accumulatedMessage;
      setComposerDraftPrompt(conversation.threadId, restored);
    },
    [promptRef, setComposerDraftPrompt],
  );

  useEffect(() => {
    const conversation = pendingAutomationConversationRef.current;
    if (conversation && conversation.threadId !== threadId) {
      restorePendingAutomationConversationDraft(conversation);
      pendingAutomationConversationRef.current = null;
    }
    if (pendingAutomationConversationRef.current === null) {
      setPendingAutomationConversation(null);
    }
    return () => {
      const pendingConversation = pendingAutomationConversationRef.current;
      if (!pendingConversation) return;
      restorePendingAutomationConversationDraft(pendingConversation);
      pendingAutomationConversationRef.current = null;
    };
  }, [restorePendingAutomationConversationDraft, threadId]);

  const cancelAutomationConversation = useCallback(() => {
    if (pendingAutomationConversation) {
      const draft = promptRef.current.trim();
      const restored = draft
        ? `${pendingAutomationConversation.accumulatedMessage}\n${draft}`
        : pendingAutomationConversation.accumulatedMessage;
      if (pendingAutomationConversation.threadId === threadId) {
        promptRef.current = restored;
      }
      setComposerDraftPrompt(pendingAutomationConversation.threadId, restored);
    }
    pendingAutomationConversationRef.current = null;
    setPendingAutomationConversation(null);
  }, [pendingAutomationConversation, promptRef, setComposerDraftPrompt, threadId]);

  const toggleAutomationWarning = useCallback((id: AutomationDraftWarningId, checked: boolean) => {
    setAcknowledgedAutomationWarnings((current) =>
      updateAutomationDraftWarningAcknowledgement(current, id, checked),
    );
  }, []);
  const updateAutomationDraftForm = useCallback(
    (nextForm: AutomationFormState) => {
      setAutomationDraftForm(nextForm);
      setAutomationDraftWarnings(
        buildAutomationDraftWarnings({
          schedule: scheduleFromForm(nextForm),
          mode: nextForm.mode,
          runtimeMode: nextForm.runtimeMode,
          worktreeMode: nextForm.worktreeMode,
          hasEphemeralContext: automationDraftWarningContext.hasEphemeralContext,
          generatedConfidence: automationDraftWarningContext.generatedConfidence,
          generatedNeedsConfirmation: automationDraftWarningContext.generatedNeedsConfirmation,
          prompt: nextForm.prompt,
        }),
      );
    },
    [automationDraftWarningContext],
  );
  const resetAutomationDraftState = useCallback(() => {
    setAutomationDraftOpen(false);
    setAutomationDraftForm(null);
    setAutomationDraftWarnings([]);
    setAutomationDraftWarningContext(EMPTY_WARNING_CONTEXT);
    setAcknowledgedAutomationWarnings(new Set());
  }, []);
  const setAutomationDraftDialogOpen = useCallback((open: boolean) => {
    setAutomationDraftOpen(open);
  }, []);

  return {
    automationProjects,
    automationThreads,
    automationData,
    automationUpdateMutation,
    automationDraftForm,
    setAutomationDraftForm,
    automationDraftWarnings,
    setAutomationDraftWarnings,
    automationDraftWarningContext,
    setAutomationDraftWarningContext,
    acknowledgedAutomationWarnings,
    setAcknowledgedAutomationWarnings,
    automationDraftOpen,
    setAutomationDraftOpen,
    setAutomationDraftDialogOpen,
    isAutomationDraftSubmitting,
    setIsAutomationDraftSubmitting,
    automationDraftSubmittingRef,
    pendingAutomationConversation,
    setPendingAutomationConversation,
    activeThreadIdRef,
    pendingAutomationConversationRef,
    hasLiveTurnRef,
    isPendingSetupBubbleId,
    cancelAutomationConversation,
    toggleAutomationWarning,
    updateAutomationDraftForm,
    resetAutomationDraftState,
  };
}
