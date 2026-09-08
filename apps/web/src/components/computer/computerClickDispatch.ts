export interface ComputerClickPoint {
  readonly x: number;
  readonly y: number;
}

export interface ComputerClickCommand extends ComputerClickPoint {
  readonly clickCount: 1 | 2;
}

export interface ComputerClickDispatch {
  readonly click: (point: ComputerClickPoint, detail: number) => void;
  /** Commit the waiting click before queueing another kind of input. */
  readonly flush: () => void;
  /** Discard the waiting click when control stops or the pane detaches. */
  readonly cancel: () => void;
}

// This is the pane's pairing budget, not a claim about the OS double-click
// setting. Longer browser pairs fall back to two singles, never three clicks.
export const COMPUTER_DOUBLE_CLICK_WAIT_MS = 500;

/**
 * Aggregate DOM clicks before they enter the input RPC queue. Two separate RPCs
 * cannot preserve a double-click interval when the first waits on the desktop.
 * Browser click detail identifies pairs, including double + single for a triple.
 */
export function createComputerClickDispatch(options: {
  readonly dispatch: (command: ComputerClickCommand) => void;
  readonly delayMs?: number;
}): ComputerClickDispatch {
  let pending: { readonly point: ComputerClickPoint; readonly detail: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };

  const flush = () => {
    const click = pending;
    cancel();
    if (click) options.dispatch({ ...click.point, clickCount: 1 });
  };

  return {
    click: (point, detail) => {
      if (pending && detail === pending.detail + 1 && detail % 2 === 0) {
        cancel();
        options.dispatch({ x: point.x, y: point.y, clickCount: 2 });
        return;
      }

      // A new browser sequence, or another input flushed by the caller, must
      // not overtake the first click. If its timer already fired, an even detail
      // contributes only the remaining single; upgrading would send three clicks.
      flush();
      if (!Number.isInteger(detail) || detail <= 0 || detail % 2 === 0) {
        options.dispatch({ x: point.x, y: point.y, clickCount: 1 });
        return;
      }

      pending = { point: { x: point.x, y: point.y }, detail };
      timer = setTimeout(flush, options.delayMs ?? COMPUTER_DOUBLE_CLICK_WAIT_MS);
    },
    flush,
    cancel,
  };
}
