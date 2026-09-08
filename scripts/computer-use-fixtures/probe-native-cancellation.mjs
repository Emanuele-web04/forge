// Control-plane probe only: never requests a capture, permission or input tool.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import nativeRelease from "../../packages/shared/src/cuaDriverRelease.json" with { type: "json" };

const driver = process.argv[2];
if (!driver || !isAbsolute(driver)) throw new Error("Supply an absolute patched driver path.");
const directory = await mkdtemp("/private/tmp/synara-cua-cancel-probe-");
await chmod(directory, 0o700);
const socketPath = join(directory, "driver.sock");
const child = spawn(driver, ["serve", "--embedded", "--no-overlay", "--socket", socketPath], {
  stdio: ["pipe", "ignore", "pipe"],
  env: {
    ...process.env,
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_PERMISSION_MODE: "standard",
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
    CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
    CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid),
    CUA_DRIVER_RS_HOME: join(directory, "state"),
  },
});
const exited = once(child, "exit");
let diagnostic = "";
child.stderr.on("data", (chunk) => {
  diagnostic = (diagnostic + chunk).slice(-16_384);
});
function request(value, timeout = 4_000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let bytes = "";
    socket.setTimeout(timeout, () => socket.destroy(new Error("Native probe timed out.")));
    socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", (chunk) => {
      bytes += chunk;
      if (bytes.length > 65_536) {
        socket.destroy(new Error("Native probe response too large."));
        return;
      }
      const end = bytes.indexOf("\n");
      if (end < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(bytes.slice(0, end)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}
const report = {
  driver,
  driverPid: child.pid,
  inputToolsCalled: 0,
  readinessToolsCalled: 0,
  cases: [],
};
try {
  let metadata;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error("Driver exited before metadata.");
    try {
      metadata = await request({ method: "metadata" }, 200);
      break;
    } catch {
      await delay(100);
    }
  }
  assert.equal(metadata?.result?.pid, child.pid);
  assert.equal(metadata?.result?.driver_version, nativeRelease.version);
  assert.equal(metadata?.result?.synara_native_revision, nativeRelease.nativeRevision);
  assert.equal(metadata?.result?.embedded, true);
  report.metadata = metadata.result;
  report.cases.push({ name: "patched-identity", passed: true });

  // Metadata for a deliberately nonexistent exact target; never captures or
  // addresses a user's application and never invokes an input actuator.
  const readiness = await request({
    method: "call",
    name: "check_input_ready",
    args: { pid: 2_147_483_647, window_id: 4_294_967_295 },
  });
  report.readinessToolsCalled += 1;
  assert.equal(readiness.ok, true);
  assert.equal(readiness.result?.structuredContent?.ready, false);
  assert.equal(readiness.result?.structuredContent?.effect, "refused");
  assert.equal(readiness.result?.structuredContent?.code, "stale_target");
  assert.equal(readiness.result?.structuredContent?.pid, 2_147_483_647);
  assert.equal(readiness.result?.structuredContent?.window_id, 4_294_967_295);
  report.cases.push({ name: "read-only-target-readiness-refusal", passed: true });

  const wrongPid = await request({ method: "cancel_input", args: { expected_pid: child.pid + 1 } });
  assert.equal(wrongPid.ok, false);
  report.cases.push({ name: "wrong-generation-refused", passed: true });

  const outsiderScript = `import {createConnection} from 'node:net';
    const s=createConnection(${JSON.stringify(socketPath)}); let data='';
    s.setTimeout(4000,()=>s.destroy(new Error('peer timeout')));
    s.once('connect',()=>s.write(${JSON.stringify(JSON.stringify({ method: "cancel_input", args: { expected_pid: child.pid } }) + "\n")}));
    s.on('data',chunk=>{ data+=chunk; if(data.includes('\\n')){ process.stdout.write(data); s.end(); }});
    s.on('error',()=>process.exitCode=1);`;
  const outsider = spawn(process.execPath, ["--input-type=module", "-e", outsiderScript], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outsiderReply = "";
  outsider.stdout.on("data", (chunk) => {
    outsiderReply += chunk;
  });
  outsider.stderr.resume();
  const [code] = await once(outsider, "exit");
  assert.equal(code, 0);
  assert.equal(JSON.parse(outsiderReply).ok, false);
  report.cases.push({ name: "non-host-peer-refused", passed: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    const cancelled = await request({ method: "cancel_input", args: { expected_pid: child.pid } });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.result?.cleanup_complete, true);
    assert.equal(cancelled.result?.input_admission_closed, true);
    assert.equal(cancelled.result?.pending_input, 0);
    assert.equal(cancelled.result?.pid, child.pid);
    report.cases.push({
      name: attempt ? "repeat-cleanup" : "host-cleanup-acknowledged",
      passed: true,
    });
  }
  await request({ method: "shutdown_if_pid", args: { expected_pid: child.pid } });
} catch (error) {
  report.failure = String(error);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const force = setTimeout(() => child.kill("SIGTERM"), 3_000);
  const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const [code, signal] = await exited;
  clearTimeout(force);
  clearTimeout(kill);
  report.exit = { code, signal };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(directory, "driver.log"), diagnostic);
  console.log(JSON.stringify({ directory, ...report }, null, 2));
}
