import { randomUUID } from "node:crypto";
import type { ProviderApprovalDecision } from "@synara/contracts";

interface PendingApproval {
  readonly threadId: string;
  readonly settle: (decision: ProviderApprovalDecision) => void;
}

/** Synara-owned approvals for providers without a native permission callback.
 * Entries exist only while their exact MCP call is alive; restart/stop cannot
 * reuse an approval. The runtime service routes user decisions here first.
 */
export class ComputerApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();

  respond(threadId: string, requestId: string, decision: ProviderApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.threadId !== threadId) return false;
    this.pending.delete(requestId);
    // Session-wide approval is deliberately unavailable for this gate.
    pending.settle(decision === "acceptForSession" ? "decline" : decision);
    return true;
  }

  async request(input: {
    threadId: string;
    signal: AbortSignal;
    publish: (requestId: string, decision?: ProviderApprovalDecision) => Promise<void>;
  }): Promise<boolean> {
    input.signal.throwIfAborted();
    if (this.pending.size >= 128) throw new Error("Too many computer approvals are waiting.");
    const requestId = `computer:${randomUUID()}`;
    let settle!: (decision: ProviderApprovalDecision) => void;
    const answer = new Promise<ProviderApprovalDecision>((resolve) => {
      settle = resolve;
    });
    this.pending.set(requestId, { threadId: input.threadId, settle });
    const cancel = () => settle("cancel");
    input.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 5 * 60_000);
    timeout.unref?.();
    let decision: ProviderApprovalDecision = "cancel";
    try {
      await input.publish(requestId);
      if (input.signal.aborted) cancel();
      decision = await answer;
      input.signal.throwIfAborted();
      return decision === "accept";
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", cancel);
      this.pending.delete(requestId);
      await input.publish(requestId, decision);
    }
  }
}

export const computerApprovalGate = new ComputerApprovalGate();
