import { networkInterfaces } from "node:os";

export interface EndpointReporterOptions {
  readonly report: () => Promise<void>;
  readonly intervalMs?: number;
  readonly fingerprint?: () => string;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}

export function networkFingerprint(): string {
  return JSON.stringify(
    Object.entries(networkInterfaces())
      .flatMap(([name, addresses]) =>
        (addresses ?? []).map((address) => [
          name,
          address.address,
          address.family,
          address.internal,
          address.scopeid,
        ]),
      )
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

/** Reports once on startup and again whenever the machine's network topology changes. */
export function startEndpointReporter(options: EndpointReporterOptions): () => void {
  const fingerprint = options.fingerprint ?? networkFingerprint;
  let previous = fingerprint();
  let reporting = false;
  let pending = true;
  const flush = async () => {
    if (reporting) {
      pending = true;
      return;
    }
    reporting = true;
    try {
      do {
        pending = false;
        await options.report().catch(() => {});
      } while (pending);
    } finally {
      reporting = false;
    }
  };
  void flush();
  const interval = (options.setIntervalFn ?? setInterval)(() => {
    const current = fingerprint();
    if (current === previous) return;
    previous = current;
    void flush();
  }, options.intervalMs ?? 10_000);
  interval.unref?.();
  return () => (options.clearIntervalFn ?? clearInterval)(interval);
}
