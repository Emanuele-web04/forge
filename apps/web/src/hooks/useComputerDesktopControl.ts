import type { ThreadId } from "@synara/contracts";
import { useMutation } from "@tanstack/react-query";

import { interruptThreadTurn } from "~/lib/threadTurnInterrupt";
import { selectThreadComputerState, useComputerStateStore } from "../computerStateStore";

export interface ComputerDesktopControl {
  readonly agentActive: boolean;
  readonly visibleDesktop: boolean;
  readonly stopRequested: boolean;
  readonly stop: () => void;
  readonly stopError: string | null;
}

export function useComputerDesktopControl(threadId: ThreadId): ComputerDesktopControl {
  const threadState = useComputerStateStore(selectThreadComputerState(threadId));
  const owner = threadState?.controlOwnerThreadId;
  // Ownership lasts for the turn, including model thinking between tool calls.
  // It gives the Stop control a stable lifetime without a debounce timer.
  const agentActive = owner !== undefined || (threadState?.agentActive ?? false);
  const ownerThreadId = owner ?? threadId;
  const interrupt = useMutation({ mutationFn: interruptThreadTurn });
  const currentRequest = interrupt.variables === ownerThreadId;
  const stopError = currentRequest && agentActive ? interrupt.error : null;

  return {
    agentActive,
    visibleDesktop: threadState?.capabilities.visibleDesktop ?? false,
    stopRequested: currentRequest && agentActive && interrupt.isPending,
    stop: () => {
      if (!interrupt.isPending) interrupt.mutate(ownerThreadId);
    },
    stopError: stopError
      ? stopError.message || "The stop request failed. Try again in a moment."
      : null,
  };
}
