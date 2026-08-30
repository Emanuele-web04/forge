/**
 * The bits of D-Bus mechanics every desktop path needs and none of them should
 * own a copy of.
 *
 * Two things live here. Unwrapping a variant, because a value read off the bus
 * arrives wrapped or not depending on which transport and which library carried
 * it, and every parser above this has to see through that the same way. And the
 * timeout race, because a D-Bus call that is never answered is otherwise a
 * promise that never settles and a session that never recovers.
 *
 * The timeout deliberately does not decide what a timeout *is*. Each caller's
 * error type carries its own recovery: a plugin timeout is connection-level and
 * drives a reconnect, while a probe's timeout is a plain answer of "not here".
 * Those are not cosmetic differences, so the mechanism is shared and the
 * meaning is not.
 *
 * @module computer/dbusPlumbing
 */

/** Unwraps a D-Bus variant, however many layers deep it was wrapped. */
export function unwrapDbusValue(value: unknown): unknown {
  if (isDbusVariant(value)) {
    return unwrapDbusValue((value as { readonly value: unknown }).value);
  }
  return value;
}

function isDbusVariant(
  value: unknown,
): value is { readonly signature: string; readonly value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly signature?: unknown }).signature === "string" &&
    "value" in value
  );
}

export interface DbusTimeoutHandlers {
  /** The rejection for a call that never answered. Built lazily, on expiry. */
  readonly onTimeout: () => unknown;
  /**
   * Translates a failure the bus did report. Omitted, the original travels
   * untouched — which is what a caller that already speaks in bus errors wants.
   */
  readonly onRejected?: ((error: unknown) => unknown) | undefined;
}

/**
 * `promise`, but rejecting with `handlers.onTimeout()` if it has not settled
 * within `timeoutMs`.
 *
 * The timer is unref'd: a pending D-Bus call must not be the reason the process
 * stays alive, and it is cleared either way so a settled call leaves nothing
 * behind.
 */
export function withDbusTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  handlers: DbusTimeoutHandlers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(handlers.onTimeout());
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(handlers.onRejected ? handlers.onRejected(error) : error);
      },
    );
  });
}
