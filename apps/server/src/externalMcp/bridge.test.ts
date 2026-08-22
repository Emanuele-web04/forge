import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverExternalMcpRuntime,
  externalMcpClientStorePath,
  fetchExternalMcpWithTimeout,
  isOwnerPrivateWindowsRuntimeAcl,
  makeWindowsRuntimeAclPowerShellInvocation,
  pairExternalMcpClient,
  readExternalMcpResponseText,
  readExternalMcpClientCredential,
  requestTimeoutForBody,
  serveExternalMcpStdio,
  writeExternalMcpClientCredential,
} from "./bridge.ts";
import {
  computeExternalMcpRuntimeProof,
  EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER,
} from "./runtimeProof.ts";

const temporaryDirectories: string[] = [];
const RUNTIME_SECRET = "bridge-test-runtime-secret-000000001";

function makeBaseDir() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "synara-mcp-bridge-test-"));
  temporaryDirectories.push(value);
  return value;
}

function writeRuntime(baseDir: string, kind: "userdata" | "dev", port: number) {
  const directory = path.join(baseDir, kind);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const runtimePath = path.join(directory, "server-runtime.json");
  fs.writeFileSync(
    runtimePath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port,
      origin: `http://127.0.0.1:${port}`,
      startedAt: new Date().toISOString(),
      externalMcpRuntimeSecret: RUNTIME_SECRET,
    }),
    { mode: 0o600 },
  );
  if (process.platform !== "win32") fs.chmodSync(runtimePath, 0o600);
}

function runtimeChallenge(url: string | URL | Request, init?: RequestInit): Response | null {
  if (!String(url).endsWith("/api/mcp/external/runtime-challenge")) return null;
  const nonce = new Headers(init?.headers).get(EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER)!;
  return Response.json({ proof: computeExternalMcpRuntimeProof(RUNTIME_SECRET, nonce) });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("external MCP stdio bridge", () => {
  it("accepts only current-user private Windows runtime ACL snapshots", () => {
    const privateAcl = {
      currentSid: "S-1-5-21-current",
      ownerSid: "S-1-5-21-current",
      hasDacl: true,
      isReparsePoint: false,
      rules: [
        { sid: "S-1-5-21-current", type: "Allow" },
        { sid: "S-1-5-18", type: "Allow" },
        { sid: "S-1-5-32-544", type: "Allow" },
      ],
    };
    expect(isOwnerPrivateWindowsRuntimeAcl(privateAcl)).toBe(true);
    expect(
      isOwnerPrivateWindowsRuntimeAcl({
        ...privateAcl,
        rules: [...privateAcl.rules, { sid: "S-1-5-32-545", type: "Allow" }],
      }),
    ).toBe(false);
    expect(isOwnerPrivateWindowsRuntimeAcl({ ...privateAcl, isReparsePoint: true })).toBe(false);
    expect(isOwnerPrivateWindowsRuntimeAcl({ ...privateAcl, hasDacl: false })).toBe(false);
    expect(isOwnerPrivateWindowsRuntimeAcl({ ...privateAcl, ownerSid: "S-1-5-21-other" })).toBe(
      false,
    );
  });

  it("passes hostile Windows runtime paths outside the encoded PowerShell program", () => {
    const targetPath = "C:\\shared dir\\'; Write-Output injected; #\\server-runtime.json";
    const invocation = makeWindowsRuntimeAclPowerShellInvocation(targetPath);

    expect(invocation.args).toContain("-EncodedCommand");
    expect(invocation.args.join(" ")).not.toContain(targetPath);
    expect(invocation.options.env.SYNARA_RUNTIME_ACL_TARGET).toBe(targetPath);
    expect(invocation.options.timeout).toBe(5_000);
  });

  it("allows the server's default wait duration when timeoutMs is omitted", () => {
    expect(
      requestTimeoutForBody(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "synara_wait_for_task", arguments: { threadId: "thread-1" } },
        }),
      ),
    ).toBe(35_000);
    expect(
      requestTimeoutForBody(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "synara_wait_for_task",
            arguments: { threadId: "thread-1", timeoutMs: 60_000 },
          },
        }),
      ),
    ).toBe(65_000);
    expect(
      requestTimeoutForBody(
        JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "synara_wait_for_task", arguments: { threadId: "thread-1" } },
          },
          {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "synara_wait_for_task", arguments: { threadId: "thread-2" } },
          },
        ]),
      ),
    ).toBe(65_000);
    expect(
      requestTimeoutForBody(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "synara_create_task", arguments: {} },
        }),
      ),
    ).toBe(605_000);
  });

  it("fails clearly for missing and multiple running instances", () => {
    const baseDir = makeBaseDir();
    expect(() => discoverExternalMcpRuntime(baseDir)).toThrow(/No running Synara instance/);
    writeRuntime(baseDir, "userdata", 3773);
    writeRuntime(baseDir, "dev", 4773);
    expect(() => discoverExternalMcpRuntime(baseDir)).toThrow(/Multiple running Synara instances/);
  });

  it.skipIf(process.platform === "win32")(
    "rejects runtime state or its directory when other users can modify them",
    () => {
      const baseDir = makeBaseDir();
      writeRuntime(baseDir, "userdata", 3773);
      const directory = path.join(baseDir, "userdata");
      const runtimePath = path.join(directory, "server-runtime.json");

      fs.chmodSync(runtimePath, 0o644);
      expect(() => discoverExternalMcpRuntime(baseDir)).toThrow(/accessible by other users/);
      fs.chmodSync(runtimePath, 0o600);
      fs.chmodSync(directory, 0o755);
      expect(() => discoverExternalMcpRuntime(baseDir)).toThrow(/accessible by other users/);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked runtime-state file and parent directory",
    () => {
      const baseDir = makeBaseDir();
      const redirected = makeBaseDir();
      writeRuntime(redirected, "userdata", 3773);
      const runtimeDirectory = path.join(baseDir, "userdata");
      fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
      fs.symlinkSync(
        path.join(redirected, "userdata", "server-runtime.json"),
        path.join(runtimeDirectory, "server-runtime.json"),
        "file",
      );
      expect(() => discoverExternalMcpRuntime(baseDir)).toThrow(/unsafe runtime-state file/);

      fs.rmSync(runtimeDirectory, { recursive: true });
      fs.symlinkSync(path.join(redirected, "userdata"), runtimeDirectory, "dir");
      expect(() => discoverExternalMcpRuntime(baseDir)).toThrow(/unsafe runtime-state directory/);
    },
  );

  it("stores credentials with private POSIX permissions and rejects widened permissions", () => {
    const baseDir = makeBaseDir();
    const filePath = writeExternalMcpClientCredential(baseDir, {
      integrationId: "integration-1",
      name: "Codex",
      credential: "syn_mcp_v1_secret",
      expiresAt: "2026-08-20T00:00:00.000Z" as never,
    });
    expect(filePath).toBe(externalMcpClientStorePath(baseDir, "integration-1"));
    expect(readExternalMcpClientCredential(baseDir).credential).toBe("syn_mcp_v1_secret");
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      fs.chmodSync(filePath, 0o644);
      expect(() => readExternalMcpClientCredential(baseDir)).toThrow(/accessible by other users/);
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked MCP secret directory", () => {
    const baseDir = makeBaseDir();
    const redirected = makeBaseDir();
    fs.symlinkSync(redirected, path.join(baseDir, "mcp"), "dir");
    expect(() =>
      writeExternalMcpClientCredential(baseDir, {
        integrationId: "integration-symlink",
        name: "Symlink",
        credential: "syn_mcp_v1_must-not-escape",
        expiresAt: "2026-08-20T00:00:00.000Z" as never,
      }),
    ).toThrow(/private path|symlink/i);
    expect(fs.readdirSync(redirected)).toEqual([]);
  });

  it("selects one stored integration explicitly and rejects an ambiguous default", () => {
    const baseDir = makeBaseDir();
    for (const integrationId of ["integration-a", "integration-b"]) {
      writeExternalMcpClientCredential(baseDir, {
        integrationId,
        name: integrationId,
        credential: `syn_mcp_v1_${integrationId}`,
        expiresAt: "2026-08-20T00:00:00.000Z" as never,
      });
    }
    expect(() => readExternalMcpClientCredential(baseDir)).toThrow(/Multiple paired/);
    expect(readExternalMcpClientCredential(baseDir, "integration-b").credential).toBe(
      "syn_mcp_v1_integration-b",
    );
  });

  it("forwards a complete stdio MCP request and returns the JSON-RPC response", async () => {
    const baseDir = makeBaseDir();
    writeRuntime(baseDir, "userdata", 3773);
    writeExternalMcpClientCredential(baseDir, {
      integrationId: "integration-stdio",
      name: "Codex",
      credential: "syn_mcp_v1_stdio",
      expiresAt: "2026-08-20T00:00:00.000Z" as never,
    });
    const output: string[] = [];
    const errors: string[] = [];
    await serveExternalMcpStdio({
      baseDir,
      stdin: Readable.from([
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
      ]),
      stdout: new Writable({
        write: (chunk, _encoding, done) => (output.push(String(chunk)), done()),
      }),
      stderr: new Writable({
        write: (chunk, _encoding, done) => (errors.push(String(chunk)), done()),
      }),
      fetchImpl: async (url, init) => {
        const challenge = runtimeChallenge(url, init);
        if (challenge) return challenge;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer syn_mcp_v1_stdio");
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    expect(errors).toEqual([]);
    expect(output.join("")).toContain('"tools":[]');
  });

  it("rediscovers the runtime after a restart and retries the same MCP request", async () => {
    const baseDir = makeBaseDir();
    writeRuntime(baseDir, "userdata", 3773);
    writeExternalMcpClientCredential(baseDir, {
      integrationId: "integration-restart",
      name: "Codex",
      credential: "syn_mcp_v1_restart",
      expiresAt: "2026-08-20T00:00:00.000Z" as never,
    });
    const urls: string[] = [];
    const output: string[] = [];
    await serveExternalMcpStdio({
      baseDir,
      stdin: Readable.from([
        `${JSON.stringify({ jsonrpc: "2.0", id: "restart", method: "ping", params: {} })}\n`,
      ]),
      stdout: new Writable({
        write: (chunk, _encoding, done) => (output.push(String(chunk)), done()),
      }),
      stderr: new Writable({ write: (_chunk, _encoding, done) => done() }),
      fetchImpl: async (url, init) => {
        const challenge = runtimeChallenge(url, init);
        if (challenge) return challenge;
        urls.push(String(url));
        if (urls.length === 1) {
          fs.rmSync(path.join(baseDir, "userdata", "server-runtime.json"));
          writeRuntime(baseDir, "userdata", 4773);
          throw new TypeError("old Synara instance stopped");
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "restart", result: {} }), {
          status: 200,
        });
      },
    });
    expect(urls).toEqual([
      "http://127.0.0.1:3773/mcp/external",
      "http://127.0.0.1:4773/mcp/external",
    ]);
    expect(output.join("")).toContain('"id":"restart"');
  });

  it("reports a revoked credential without leaking it", async () => {
    const baseDir = makeBaseDir();
    writeRuntime(baseDir, "userdata", 3773);
    writeExternalMcpClientCredential(baseDir, {
      integrationId: "integration-revoked",
      name: "Claude",
      credential: "syn_mcp_v1_do-not-leak",
      expiresAt: "2026-08-20T00:00:00.000Z" as never,
    });
    const output: string[] = [];
    await serveExternalMcpStdio({
      baseDir,
      stdin: Readable.from([
        `${JSON.stringify({ jsonrpc: "2.0", id: "revoked", method: "ping", params: {} })}\n`,
      ]),
      stdout: new Writable({
        write: (chunk, _encoding, done) => (output.push(String(chunk)), done()),
      }),
      stderr: new Writable({ write: (_chunk, _encoding, done) => done() }),
      fetchImpl: async (url, init) =>
        runtimeChallenge(url, init) ?? new Response("unauthorized", { status: 401 }),
    });
    expect(output.join("")).toContain("revoked, expired, or replaced");
    expect(output.join("")).not.toContain("do-not-leak");
  });

  it("does not answer failed notifications and preserves every request id in a failed batch", async () => {
    const baseDir = makeBaseDir();
    writeRuntime(baseDir, "userdata", 3773);
    writeExternalMcpClientCredential(baseDir, {
      integrationId: "integration-protocol-errors",
      name: "Protocol",
      credential: "syn_mcp_v1_protocol-errors",
      expiresAt: "2026-08-20T00:00:00.000Z" as never,
    });
    const output: string[] = [];
    await serveExternalMcpStdio({
      baseDir,
      stdin: Readable.from([
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        `${JSON.stringify([
          { jsonrpc: "2.0", id: 7, method: "ping" },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: "eight", method: "ping" },
        ])}\n`,
      ]),
      stdout: new Writable({
        write: (chunk, _encoding, done) => (output.push(String(chunk)), done()),
      }),
      stderr: new Writable({ write: (_chunk, _encoding, done) => done() }),
      fetchImpl: async (url, init) =>
        runtimeChallenge(url, init) ?? new Response("unauthorized", { status: 401 }),
    });
    const responses = output
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(responses).toHaveLength(1);
    expect(responses[0].map((entry: { id: unknown }) => entry.id)).toEqual([7, "eight"]);
  });

  it("allows a fast request to complete while a wait request is still pending", async () => {
    const baseDir = makeBaseDir();
    writeRuntime(baseDir, "userdata", 3773);
    writeExternalMcpClientCredential(baseDir, {
      integrationId: "integration-concurrent",
      name: "Concurrent",
      credential: "syn_mcp_v1_concurrent",
      expiresAt: "2026-08-20T00:00:00.000Z" as never,
    });
    const output: string[] = [];
    await serveExternalMcpStdio({
      baseDir,
      stdin: Readable.from([
        `${JSON.stringify({ jsonrpc: "2.0", id: "slow", method: "tools/call", params: { name: "synara_wait_for_task", arguments: { timeoutMs: 100 } } })}\n`,
        `${JSON.stringify({ jsonrpc: "2.0", id: "fast", method: "ping" })}\n`,
      ]),
      stdout: new Writable({
        write: (chunk, _encoding, done) => (output.push(String(chunk)), done()),
      }),
      stderr: new Writable({ write: (_chunk, _encoding, done) => done() }),
      fetchImpl: async (url, init) => {
        const challenge = runtimeChallenge(url, init);
        if (challenge) return challenge;
        const request = JSON.parse(String(init?.body)) as { id: string };
        if (request.id === "slow") await new Promise((resolve) => setTimeout(resolve, 50));
        return Response.json({ jsonrpc: "2.0", id: request.id, result: {} });
      },
    });
    expect(
      output
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).id),
    ).toEqual(["fast", "slow"]);
  });

  it("aborts an active HTTP request when the MCP client cancels its request id", async () => {
    const baseDir = makeBaseDir();
    writeRuntime(baseDir, "userdata", 3773);
    writeExternalMcpClientCredential(baseDir, {
      integrationId: "integration-cancellation",
      name: "Cancellation",
      credential: "syn_mcp_v1_cancellation",
      expiresAt: "2026-08-20T00:00:00.000Z" as never,
    });
    const stdin = new PassThrough();
    const output: string[] = [];
    const errors: string[] = [];
    let requestStarted = false;
    let aborted = false;
    const serving = serveExternalMcpStdio({
      baseDir,
      stdin,
      stdout: new Writable({
        write: (chunk, _encoding, done) => (output.push(String(chunk)), done()),
      }),
      stderr: new Writable({
        write: (chunk, _encoding, done) => (errors.push(String(chunk)), done()),
      }),
      fetchImpl: async (url, init) => {
        const challenge = runtimeChallenge(url, init);
        if (challenge) return challenge;
        requestStarted = true;
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return await new Promise<Response>(() => {});
      },
    });
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "slow", method: "tools/call", params: { name: "synara_wait_for_task", arguments: { threadId: "thread-1" } } })}\n`,
    );
    while (!requestStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow" } })}\n`,
    );
    stdin.end();
    await serving;
    expect(aborted).toBe(true);
    expect(output).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("cancels one batched request without aborting its siblings", async () => {
    const baseDir = makeBaseDir();
    writeRuntime(baseDir, "userdata", 3773);
    writeExternalMcpClientCredential(baseDir, {
      integrationId: "integration-batch-cancellation",
      name: "Batch cancellation",
      credential: "syn_mcp_v1_batch-cancellation",
      expiresAt: "2026-08-20T00:00:00.000Z" as never,
    });
    const stdin = new PassThrough();
    const output: string[] = [];
    let slowStarted = false;
    let slowAborted = false;
    const serving = serveExternalMcpStdio({
      baseDir,
      stdin,
      stdout: new Writable({
        write: (chunk, _encoding, done) => (output.push(String(chunk)), done()),
      }),
      stderr: new Writable({ write: (_chunk, _encoding, done) => done() }),
      fetchImpl: async (url, init) => {
        const challenge = runtimeChallenge(url, init);
        if (challenge) return challenge;
        const request = JSON.parse(String(init?.body)) as { id: string };
        if (request.id === "slow") {
          slowStarted = true;
          init?.signal?.addEventListener("abort", () => {
            slowAborted = true;
          });
          return await new Promise<Response>(() => {});
        }
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      },
    });
    stdin.write(
      `${JSON.stringify([
        {
          jsonrpc: "2.0",
          id: "slow",
          method: "tools/call",
          params: { name: "synara_wait_for_task", arguments: { threadId: "thread-1" } },
        },
        { jsonrpc: "2.0", id: "fast", method: "ping" },
      ])}\n`,
    );
    while (!slowStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow" } })}\n`,
    );
    stdin.end();
    await serving;

    expect(slowAborted).toBe(true);
    expect(JSON.parse(output.join(""))).toEqual([
      { jsonrpc: "2.0", id: "fast", result: { ok: true } },
    ]);
  });

  it("aborts and rejects a hung fetch at its deadline", async () => {
    let aborted = false;
    await expect(
      fetchExternalMcpWithTimeout(
        async (_url, init) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return await new Promise<Response>(() => {});
        },
        new URL("http://127.0.0.1:3773/hung"),
        {},
        10,
      ),
    ).rejects.toThrow(/did not respond/);
    expect(aborted).toBe(true);
  });

  it("cancels a response body that stalls after HTTP headers", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(readExternalMcpResponseText(response, 10)).rejects.toThrow(/body stalled/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it("reuses the locally persisted client secret after a lost pairing response", async () => {
    const baseDir = makeBaseDir();
    writeRuntime(baseDir, "userdata", 3773);
    let credential = "";
    let pairingAttempts = 0;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const challenge = runtimeChallenge(url, init);
      if (challenge) return challenge;
      const request = JSON.parse(String(init?.body)) as { credential: string };
      credential ||= request.credential;
      expect(request.credential).toBe(credential);
      pairingAttempts += 1;
      if (pairingAttempts === 1) throw new TypeError("response lost after server commit");
      return Response.json({
        integrationId: "integration-pair-retry",
        name: "Pair retry",
        credential,
        expiresAt: "2026-08-20T00:00:00.000Z",
      });
    };
    const paired = await pairExternalMcpClient({
      baseDir,
      pairingCode: "syn_pair_v1_retry",
      fetchImpl,
    });
    expect(paired.paired.credential).toBe(credential);
    expect(pairingAttempts).toBe(2);
    expect(readExternalMcpClientCredential(baseDir).credential).toBe(credential);
    expect(fs.readFileSync(paired.storePath, "utf8")).not.toContain("syn_pair_v1_retry");
  });
});
