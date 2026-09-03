import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";

// The profile route is dynamic (it reads headers() for the viewer IP), so
// there is no route-level ISR here — but fetchPublicProfile() relies on the
// Next data cache (`next: { revalidate: 15 }`) to keep the account API out of
// every page load. On Workers that cache is per-isolate unless it is backed
// by a real store, so R2 carries the cache and a Durable Object queue serves
// the time-based revalidations.
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  queue: doQueue,
});
