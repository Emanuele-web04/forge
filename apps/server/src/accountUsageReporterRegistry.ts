/**
 * accountUsageReporterRegistry - the seam between sign-in and usage sync.
 *
 * The reporter is constructed in the server program (main.ts) and the
 * account session in the RPC layer; threading one into the other would drag
 * the reporter through the whole layer graph for a single method call. This
 * tiny registry decouples them: the program registers the live reporter,
 * and `establishSession` nudges it after a sign-in persists — which is what
 * makes a machine's EXISTING local history sync the moment its user logs
 * in, rather than waiting for the next turn to generate activity.
 *
 * @module accountUsageReporterRegistry
 */

let nudge: (() => void) | undefined;

export function registerAccountUsageReporterNudge(fn: (() => void) | undefined): void {
  nudge = fn;
}

/** Never throws: sign-in must not fail because usage sync is unavailable. */
export function nudgeAccountUsageReporter(): void {
  try {
    nudge?.();
  } catch {
    // The reporter's own logging covers its failures.
  }
}
