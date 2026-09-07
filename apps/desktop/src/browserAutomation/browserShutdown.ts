/** Revoke tool access, then close pages so pending CDP calls cannot hold quit open. */
export async function shutdownBrowserServices(services: {
  revokeHost(): Promise<void>;
  closePages(): void;
  stopCapture(): Promise<void>;
  clearKeys(): void;
}): Promise<void> {
  try {
    const operations = [services.revokeHost, services.closePages, services.stopCapture].map((stop) => {
      try { return Promise.resolve(stop()); }
      catch (error) { return Promise.reject(error); }
    });
    const results = await Promise.allSettled(operations);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } finally { services.clearKeys(); }
}
