import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
let cached: { until: number; value: string | undefined } | undefined;
let pending: Promise<string | undefined> | undefined;

export function parseMacHttpsProxy(output: string): string | undefined {
  if (!/^\s*HTTPSEnable\s*:\s*1\s*$/m.test(output)) return;
  const host = output.match(/^\s*HTTPSProxy\s*:\s*(\S+)\s*$/m)?.[1];
  const port = Number(output.match(/^\s*HTTPSPort\s*:\s*(\d+)\s*$/m)?.[1]);
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535) return;
  return `http://${host}:${port}`;
}

/** Only quota fetches opt in; preserve the user's existing system proxy selection. */
export async function resolveUsageLocalProxy(): Promise<string | undefined> {
  if (process.platform !== "darwin") return;
  if (cached && cached.until > Date.now()) return cached.value;
  if (pending) return pending;
  pending = exec("/usr/sbin/scutil", ["--proxy"], { timeout: 2000, maxBuffer: 32768 })
    .then(({ stdout }) => parseMacHttpsProxy(stdout))
    .catch(() => undefined)
    .then((value) => {
      cached = { until: Date.now() + 60000, value };
      return value;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}
