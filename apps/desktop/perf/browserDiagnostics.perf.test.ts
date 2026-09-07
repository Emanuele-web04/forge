// SYNARA_PERF=1 SYNARA_PERF_OUT=/tmp/diagnostics.json bun run --cwd apps/desktop test perf/browserDiagnostics.perf.test.ts
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import type { WebContents } from "electron";
import { ThreadId } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { BrowserDiagnosticsStore } from "../src/browserAutomation/browserDiagnostics";

it.skipIf(process.env.SYNARA_PERF !== "1")(
  "measures bounded browser-log reads",
  async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T00:00:00Z"));
    const report = [];
    try {
      for (const urlLength of [100, 8_000]) {
        const events = new EventEmitter();
        const runtime = {
          threadId: ThreadId.makeUnsafe("perf"),
          tabId: "025aa711-edf6-4c63-b957-d7c96a3fdabb",
          webContents: {
            isDestroyed: () => false,
            once: () => {},
            debugger: {
              isAttached: () => true,
              sendCommand: async () => ({}),
              on: events.on.bind(events),
              removeListener: events.removeListener.bind(events),
            },
          } as unknown as WebContents,
        };
        const store = new BrowserDiagnosticsStore();
        await store.observe(runtime);
        try {
          for (let index = 0; index < 200; index += 1) {
            events.emit("message", {}, "Network.requestWillBeSent", {
              requestId: `request-${index}`,
              request: {
                method: "GET",
                url: `https://example.test/${"x".repeat(urlLength)}?token=secret-${index}`,
              },
            });
          }
          const input = { includeConsole: false, includeNetwork: true, limit: 200 };
          const iterations = urlLength === 100 ? 50 : 1;
          const wallMs: number[] = [];
          let output;
          for (let sample = -3; sample < 11; sample += 1) {
            const start = performance.now();
            for (let iteration = 0; iteration < iterations; iteration += 1)
              output = await store.read(runtime, input);
            if (sample >= 0) wallMs.push((performance.now() - start) / iterations);
          }
          const json = JSON.stringify(output);
          expect(Buffer.byteLength(json)).toBeLessThanOrEqual(320 * 1_024);
          const ordered = wallMs.toSorted((a, b) => a - b);
          report.push({
            name: `read/200-entries-${urlLength}-char-url`,
            iterations,
            wallMs,
            medianMs: ordered[5],
            p95Ms: ordered[10],
            entries: output?.entries.length,
            bytes: Buffer.byteLength(json),
            outputHash: createHash("sha256").update(json).digest("hex"),
          });
        } finally {
          store.dispose(runtime);
        }
      }
    } finally {
      vi.useRealTimers();
    }
    writeFileSync(
      process.env.SYNARA_PERF_OUT ?? "/tmp/synara-diagnostics.json",
      JSON.stringify({ node: process.version, warmups: 3, samples: 11, report }, null, 2),
    );
  },
  120_000,
);
