// Read-only sampling of the two exact fixture executable paths. This script
// neither enumerates window content nor sends input or signals to processes.
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const application = join(homedir(), "Applications/Synara Cua Fixture.app");
const output = process.argv[2];
if (!output?.startsWith("/private/tmp/synara-cua-implementation/"))
  throw new Error("Use an explicit fixture output path.");
const hostPath = join(application, "Contents/MacOS/Electron");
const driverPath = join(application, "Contents/Resources/cua-driver/cua-driver");
const pattern = application.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const samples = [];
const startedAt = Date.now();
let seen = false;
// Foreground cancellation adds native generations; cover the complete bounded
// suite instead of truncating it after the first thirty seconds.
for (let attempt = 0; attempt < 240; attempt += 1) {
  let pids;
  try {
    pids = execFileSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .filter((pid) => /^\d+$/.test(pid));
  } catch (error) {
    if (error.status !== 1) throw error;
    pids = [];
  }
  const owned = [];
  if (pids.length) {
    let output;
    try {
      output = execFileSync(
        "/bin/ps",
        ["-ww", "-p", pids.join(","), "-o", "pid=,ppid=,rss=,%cpu=,time=,comm="],
        { encoding: "utf8" },
      );
    } catch (error) {
      if (error.status !== 1) throw error;
      output = "";
    }
    for (const line of output.trim().split("\n")) {
      const row = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
      if (!row || (row[6] !== hostPath && row[6] !== driverPath)) continue;
      owned.push({
        pid: Number(row[1]),
        parentPid: Number(row[2]),
        rssKiB: Number(row[3]),
        cpuPercent: Number(row[4]),
        lifetimeCpuTime: row[5],
        role: row[6] === hostPath ? "electron-main" : "cua-driver",
      });
    }
  }
  const hostPids = new Set(
    owned.filter((row) => row.role === "electron-main").map((row) => row.pid),
  );
  const processes = owned.filter(
    (row) => row.role === "electron-main" || hostPids.has(row.parentPid),
  );
  if (processes.length) {
    seen = true;
    samples.push({ elapsedMs: Date.now() - startedAt, processes });
  } else if (seen) break;
  await pause(500);
}
await writeFile(
  output,
  JSON.stringify(
    {
      capturedAt: new Date(startedAt).toISOString(),
      note: "ps samples from the exact fixture host and its child; CPU percentage is the OS estimate, not an isolated benchmark. RSS is not incremental overhead.",
      samples,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Saved ${samples.length} fixture resource samples.`);
