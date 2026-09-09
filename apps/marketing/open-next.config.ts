import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";

// This site leans on ISR far more than profiles does: docs and changelog pages
// are SSG with time-based revalidation, /install and the llms/ai/sitemap
// routes re-render on their own clocks, and releases.ts refetches GitHub every
// 30 minutes. On Workers the default caches are per-isolate, so R2 holds the
// cache and a Durable Object queue drives the time-based revalidations.
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  queue: doQueue,
});
