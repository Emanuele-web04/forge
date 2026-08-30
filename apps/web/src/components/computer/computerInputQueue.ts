// FILE: computerInputQueue.ts
// Purpose: Serialize user input sends from the computer pane to the desktop seat.
// Layer: web UI utility
// Exports: createComputerInputQueue, ComputerInputQueue
//
// The seat is a single pointer and a single keyboard. Two input RPCs in flight
// at once can reach the plugin in either order, which reorders typed characters
// and lands a click before the pointer glide that was meant to precede it. The
// queue keeps sends strictly ordered, and bounds itself so a held key or a
// spinning wheel cannot grow an unbounded backlog while the desktop is slow.

export interface ComputerInputQueue {
  /**
   * Queues one send. Returns false when the backlog is already at the limit and
   * the command was dropped rather than queued.
   */
  readonly push: (send: () => Promise<unknown>) => boolean;
  readonly pending: () => number;
  /**
   * Forgets every send that has not started. The one already talking to the
   * desktop finishes; nothing queued behind it runs.
   */
  readonly clear: () => void;
}

export const COMPUTER_INPUT_QUEUE_LIMIT = 24;

export function createComputerInputQueue(
  options: {
    readonly limit?: number;
    readonly onError?: (error: unknown) => void;
    readonly onDrop?: () => void;
  } = {},
): ComputerInputQueue {
  const limit = options.limit ?? COMPUTER_INPUT_QUEUE_LIMIT;
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let inFlight = false;
  // Bumped by clear(); a send queued under an older generation is skipped when
  // its turn comes, so stopping control never has to cancel a promise.
  let generation = 0;

  return {
    push: (send) => {
      if (pending >= limit) {
        options.onDrop?.();
        return false;
      }
      pending += 1;
      const queuedGeneration = generation;
      chain = chain.then(async () => {
        if (queuedGeneration !== generation) return;
        inFlight = true;
        try {
          await send();
        } catch (error) {
          options.onError?.(error);
        } finally {
          inFlight = false;
          pending -= 1;
        }
      });
      return true;
    },
    pending: () => pending,
    clear: () => {
      generation += 1;
      pending = inFlight ? 1 : 0;
    },
  };
}
