import type { ComputerEvent } from "@synara/contracts";

export const MAX_COMPUTER_THREAD_INTERESTS_PER_CONNECTION = 64;

interface ConnectionInterests {
  // A connection with more views falls back to broadcast instead of losing
  // updates for a view that remains open. Null also releases the remembered ids.
  threads: Set<string> | null;
}

/** Interests belong to the socket, so stream retries preserve them. */
export class ComputerEventInterests {
  private readonly connections = new Map<string, ConnectionInterests>();

  constructor(private readonly onConnectionClose: (key: string, cleanup: () => void) => boolean) {}

  private connect(connectionKey: string | undefined): void {
    if (connectionKey === undefined || this.connections.has(connectionKey)) return;
    if (this.onConnectionClose(connectionKey, () => this.connections.delete(connectionKey))) {
      this.connections.set(connectionKey, { threads: new Set() });
    }
  }

  subscribe(
    connectionKey: string | undefined,
    onEvent: (listener: (event: ComputerEvent) => void) => () => void,
    listener: (event: ComputerEvent) => void,
  ): () => void {
    this.connect(connectionKey);
    return onEvent((event) => {
      if (this.accepts(connectionKey, event)) listener(event);
    });
  }

  watch(connectionKey: string | undefined, threadId: string): void {
    this.connect(connectionKey);
    const interests = connectionKey === undefined ? undefined : this.connections.get(connectionKey);
    if (!interests?.threads) return;
    interests.threads.add(threadId);
    if (interests.threads.size > MAX_COMPUTER_THREAD_INTERESTS_PER_CONNECTION) {
      interests.threads = null;
    }
  }

  accepts(connectionKey: string | undefined, event: ComputerEvent): boolean {
    // In-process callers without the socket registry keep the prior behavior.
    if (connectionKey === undefined) return true;
    const interests = this.connections.get(connectionKey);
    if (!interests) return false;
    const threadId =
      event.type === "computer.thread-state"
        ? event.state.threadId
        : event.type === "computer.action"
          ? event.threadId
          : undefined;
    return threadId === undefined || interests.threads === null || interests.threads.has(threadId);
  }
}
