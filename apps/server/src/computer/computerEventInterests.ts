import type { ComputerEvent } from "@synara/contracts";

/** Bound remembered views even when a client reads state without subscribing. */
export class ComputerEventInterests {
  private readonly clients = new Map<number, Set<string>>();

  watch(clientId: number, threadId: string): void {
    const threads = this.clients.get(clientId) ?? new Set<string>();
    threads.delete(threadId);
    threads.add(threadId);
    if (threads.size > 64) threads.delete(threads.values().next().value!);
    this.clients.delete(clientId);
    this.clients.set(clientId, threads);
    if (this.clients.size > 256) this.clients.delete(this.clients.keys().next().value!);
  }

  accepts(clientId: number, event: ComputerEvent): boolean {
    const threadId =
      event.type === "computer.thread-state"
        ? event.state.threadId
        : event.type === "computer.action"
          ? event.threadId
          : undefined;
    return threadId === undefined || this.clients.get(clientId)?.has(threadId) === true;
  }

  forget(clientId: number): void {
    this.clients.delete(clientId);
  }
}
