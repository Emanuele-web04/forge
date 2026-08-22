export interface DesktopProjectRecoveryAttempt {
  readonly isCurrent: () => boolean;
  readonly complete: () => boolean;
  readonly release: () => void;
}

export interface DesktopProjectRecoveryAttemptGate {
  readonly begin: () => DesktopProjectRecoveryAttempt | null;
}

/**
 * Owns the one-shot desktop recovery attempt across effect restarts.
 *
 * Releasing an in-flight attempt lets a dependency-driven effect rerun take
 * ownership. A stale response or rejection can then only release its own token,
 * while a completed attempt permanently closes the gate for this mount.
 */
export function createDesktopProjectRecoveryAttemptGate(): DesktopProjectRecoveryAttemptGate {
  let currentOwner: symbol | "completed" | null = null;

  return {
    begin: () => {
      if (currentOwner !== null) return null;

      const owner = Symbol("desktop-project-recovery");
      currentOwner = owner;
      const isCurrent = () => currentOwner === owner;

      return {
        isCurrent,
        complete: () => {
          if (!isCurrent()) return false;
          currentOwner = "completed";
          return true;
        },
        release: () => {
          if (isCurrent()) currentOwner = null;
        },
      };
    },
  };
}
