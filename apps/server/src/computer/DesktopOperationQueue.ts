import { AsyncLocalStorage } from "node:async_hooks";

import { ComputerBackendError } from "./ComputerBackend.ts";

const execution = new AsyncLocalStorage<{ active: boolean; signal?: AbortSignal | undefined }>();
export function desktopOperationSignal(): AbortSignal | undefined {
  const operation = execution.getStore();
  return operation?.active ? operation.signal : undefined;
}
export async function withDesktopOperationSignal<A>(
  signal: AbortSignal,
  action: () => Promise<A>,
): Promise<A> {
  const parent = desktopOperationSignal();
  const scope = { active: true, signal: parent ? AbortSignal.any([parent, signal]) : signal };
  try {
    return await execution.run(scope, action);
  } finally {
    scope.active = false;
  }
}
/** A detached continuation cannot turn a completed call into fresh input authority. */
export function assertDesktopOperationAdmission(): void {
  const operation = execution.getStore();
  if (operation && !operation.active) {
    throw new ComputerBackendError(
      "The computer operation has ended; no new input may be dispatched.",
    );
  }
  operation?.signal?.throwIfAborted();
}

export function assertDesktopOperationActive(): void {
  desktopOperationSignal()?.throwIfAborted();
}

export function withoutDesktopCancellation<A>(action: () => A): A {
  return execution.run({ active: true }, action);
}

const delivery = new AsyncLocalStorage<"background" | "foreground">();
export const desktopDeliveryMode = () => delivery.getStore() ?? "background";
export const withDesktopDeliveryMode = <A>(mode: "background" | "foreground", action: () => A): A =>
  delivery.run(mode, action);

export const DESKTOP_OPERATION_QUEUE_LIMIT = 64;

/** One desktop operation includes targeting, input, and its returned observation. */
export class DesktopOperationQueue {
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private activeController: AbortController | undefined;

  run<A>(action: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    if (this.closed) return Promise.reject(new ComputerBackendError("Computer manager is closed."));
    // Tool calls wrap manager actions in the same transaction. Detached work
    // must enqueue again once that transaction finishes.
    if (this.context.getStore()?.active) {
      assertDesktopOperationActive();
      if (signal) {
        return withDesktopOperationSignal(signal, async () => {
          assertDesktopOperationActive();
          return action();
        });
      }
      return action();
    }
    if (this.pending >= DESKTOP_OPERATION_QUEUE_LIMIT) {
      return Promise.reject(
        new ComputerBackendError("Too many computer operations are queued; try again later.", {
          retryable: true,
        }),
      );
    }
    // Capture the caller's live scope before waiting: the queue owns its own
    // transaction, but RPC interruption and caller revocation still cancel it.
    const inheritedSignal = desktopOperationSignal();
    const callerSignal =
      signal && inheritedSignal
        ? AbortSignal.any([signal, inheritedSignal])
        : (signal ?? inheritedSignal);
    this.pending += 1;
    const result = this.tail.then(async () => {
      if (this.closed) throw new ComputerBackendError("Computer manager is closed.");
      callerSignal?.throwIfAborted();
      const controller = new AbortController();
      this.activeController = controller;
      const transaction = {
        active: true,
        signal: callerSignal
          ? AbortSignal.any([callerSignal, controller.signal])
          : controller.signal,
      };
      try {
        return await execution.run(transaction, () => this.context.run(transaction, action));
      } finally {
        transaction.active = false;
        this.activeController = undefined;
      }
    });
    this.tail = result.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );
    return result;
  }

  /** Abort active work and reject queued work; native cleanup is backend-owned. */
  async close(): Promise<void> {
    this.closed = true;
    this.activeController?.abort();
    await this.tail;
  }
}
