import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { CuaDriverHost } from "./cuaDriverHost";
import {
  cuaRequest as rawCuaRequest,
  CUA_DRIVER_VERSION,
  CUA_NATIVE_REVISION,
} from "@synara/shared/cuaDriverProtocol";
const capability = "isolated-fixture-authority-00000000000000";
const cuaRequest: typeof rawCuaRequest = (path, request, options) =>
  rawCuaRequest(path, { ...(request as object), capability }, options);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  authority = capability,
  options: {
    cleanup?: "incomplete" | "wrong-pid" | "missing-admission";
    unpatched?: boolean;
    failAction?: boolean;
    crash?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "synara-cua-host-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "events.jsonl");
  const binary = join(directory, "driver");
  await writeFile(
    binary,
    `#!${process.execPath}
const net=require('node:net'),fs=require('node:fs');
const log=${JSON.stringify(log)}, options=${JSON.stringify(options)};
const write=event=>fs.appendFileSync(log,JSON.stringify({event,pid:process.pid,time:Date.now()})+'\\n');
write('start');
const socket=process.argv[process.argv.indexOf('--socket')+1];
let action, timer;
net.createServer(s=>{
  const reply=result=>s.end(JSON.stringify({ok:true,result})+'\\n');
  s.once('data',b=>{
    const r=JSON.parse(b.toString());
    if(r.method==='metadata') reply({driver_version:${JSON.stringify(CUA_DRIVER_VERSION)},synara_native_revision:options.unpatched?undefined:${CUA_NATIVE_REVISION},embedded:true,pid:process.pid});
    else if(r.method==='cancel_input') {
      write('cancel');
      if(r.args.expected_pid!==process.pid) throw new Error('Wrong generation');
      clearTimeout(timer);
      if(action) { write('release'); action.end(JSON.stringify({ok:false,error:'cancelled'})+'\\n'); action=undefined; }
      setTimeout(()=>{
        write('cleanup-ack');
        reply({pid:process.pid+(options.cleanup==='wrong-pid'?1:0),input_admission_closed:options.cleanup==='missing-admission'?undefined:true,cleanup_complete:options.cleanup!=='incomplete',pending_input:options.cleanup==='incomplete'?1:0});
      },30);
    }
    else if(r.name==='type_text') {
      write('dispatch'); action=s;
      if(options.crash) { write('crash'); process.exit(1); }
      else if(options.failAction) s.destroy();
      else timer=setTimeout(()=>{write('effect');reply({});action=undefined},10000);
    }
    else reply({});
  });
  s.on('error',()=>{});
}).listen(socket);
let retiring=false;
function retire(){if(retiring)return;retiring=true;write('retiring');setTimeout(()=>{write('exit');process.exit(0)},150)}
process.on('SIGTERM',retire);
process.stdin.resume(); process.stdin.on('end',retire);
`,
  );
  await chmod(binary, 0o755);
  const host = new CuaDriverHost({
    binaryPath: binary,
    bundleId: "fixture",
    capability: authority,
    setup: async () => {},
  });
  const events = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
  cleanups.push(async () => {
    try {
      await host.dispose();
    } catch (error) {
      if (!options.cleanup && !options.crash) throw error;
    }
    // These are fake executables created by this test, with no OS input API.
    // A deliberately invalid cleanup acknowledgement must leave them alive.
    for (const event of await events().catch(() => [])) {
      if (event.event === "start") {
        try {
          process.kill(event.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }
  });
  const endpoint = await host.listen();
  return { host, endpoint, events };
}
describe("Cua GUI host retirement", () => {
  it("preserves multibyte UTF-8 across incoming socket chunks", async () => {
    const authority = capability + "-è🧪";
    const f = await fixture(authority);
    const request = Buffer.from(JSON.stringify({ method: "probe", capability: authority }) + "\n");
    const split = request.indexOf(Buffer.from("🧪")) + 1;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(f.endpoint);
      let result = "";
      socket.setTimeout(2_000, () => socket.destroy(new Error("Fixture socket timed out.")));
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        result += chunk.toString("utf8");
      });
      socket.once("end", () => resolve(result));
      socket.once("connect", () => {
        socket.write(request.subarray(0, split));
        setTimeout(() => socket.write(request.subarray(split)), 30);
      });
    });
    expect(JSON.parse(reply)).toMatchObject({ ok: true });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires GUI authority even when a provider discovers the socket", async () => {
    const f = await fixture();
    await expect(
      rawCuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("releases uncertain input before termination and waits for exit before replacement", async () => {
    const f = await fixture();
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions", args: {} });
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 120, mutation: true },
      ),
    ).rejects.toMatchObject({ effect: "dispatched-unknown" });
    await f.host.stop();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions", args: {} }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((e) => e.event === "start");
    expect(starts).toHaveLength(2);
    const exit = events.find((e) => e.event === "exit" && e.pid === starts[0].pid);
    expect(exit).toBeDefined();
    expect(starts[1].time).toBeGreaterThanOrEqual(exit.time);
    expect(events.some((e) => e.event === "effect")).toBe(false);
    expect(events.filter((e) => e.event === "dispatch")).toHaveLength(1);
    const first = events.filter((e) => e.pid === starts[0].pid).map((e) => e.event);
    expect(first).toEqual([
      "start",
      "dispatch",
      "cancel",
      "release",
      "cleanup-ack",
      "retiring",
      "exit",
    ]);
  });
  it("rejects later backend requests throughout suspension and resumes only on explicit restart", async () => {
    const f = await fixture();
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    const stopping = f.host.suspend();
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "must not arrive" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      effect: "not-dispatched",
      error: expect.stringContaining("suspended"),
    });
    await stopping;
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(false);
    f.host.resume();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((event) => event.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1].time).toBeGreaterThanOrEqual(
      events.find((event) => event.event === "exit" && event.pid === starts[0].pid).time,
    );
  });
  it("does not let resume bypass failed cleanup during backend suspension", async () => {
    const f = await fixture(capability, { cleanup: "incomplete" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await expect(f.host.suspend()).rejects.toThrow("did not confirm native input cleanup");
    f.host.resume();
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "must not arrive" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(false);
  });
  it.each(["incomplete", "wrong-pid", "missing-admission"] as const)(
    "keeps the process alive and blocks replacement after %s cleanup",
    async (cleanup) => {
      const f = await fixture(capability, { cleanup });
      await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
      await expect(f.host.stop()).rejects.toThrow("did not confirm native input cleanup");
      await expect(
        cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
      ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      const events = await f.events();
      expect(events.map((e) => e.event)).toEqual(["start", "cancel", "cleanup-ack"]);
      expect(() => process.kill(events[0].pid, 0)).not.toThrow();
    },
  );
  it("preserves an uncertain action effect when cleanup also fails", async () => {
    const f = await fixture(capability, { cleanup: "incomplete", failAction: true });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "type_text", args: { text: "fixture" } }),
    ).resolves.toMatchObject({
      ok: false,
      effect: "dispatched-unknown",
      error: expect.stringContaining("did not confirm native input cleanup"),
    });
    expect((await f.events()).some((e) => e.event === "retiring")).toBe(false);
  });
  it("blocks replacement when a driver crashes during input", async () => {
    const f = await fixture(capability, { crash: true });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "type_text", args: { text: "fixture" } }),
    ).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((e) => e.event === "start")).toHaveLength(1);
  });
  it("rejects an upstream binary before native input is admitted", async () => {
    const f = await fixture(capability, { unpatched: true });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "type_text", args: { text: "fixture" } }),
    ).resolves.toMatchObject({
      ok: false,
      effect: "not-dispatched",
      error: expect.stringContaining("native revision handshake failed"),
    });
    expect((await f.events()).map((e) => e.event)).toEqual(["start", "retiring", "exit"]);
  });
  it("refuses unlisted driver operations before starting a daemon", async () => {
    const f = await fixture();
    const response = await cuaRequest<{ ok: boolean }>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: { url: "https://example.com" },
    });
    expect(response.ok).toBe(false);
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
});
