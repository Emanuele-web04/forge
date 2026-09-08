import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  HELPER_SHUTDOWN_GRACE_MS,
  MAC_HELPER_METHODS,
  MacComputerHelperClient,
  MacComputerHelperError,
} from "./macComputerHelperClient.ts";

/**
 * A fake child process wired to real streams, so the client exercises the actual
 * JSON-RPC framing rather than a mock of it. `respond` maps a method to the
 * result the fake helper answers with; an unmapped method returns `{ok:true}`.
 *
 * `exitCode`/`signalCode` mirror the real child fields because `dispose()` reads
 * them to decide whether it still has to wait for an exit: a fake that leaves
 * them `undefined` makes every dispose take the already-exited shortcut and the
 * grace timer is never exercised at all.
 */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every signal `dispose()` sent, in order, so a test can see the escalation. */
  readonly signals: NodeJS.Signals[] = [];
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(
    private readonly respond: (method: string) => unknown,
    /** A wedged helper answers no SIGTERM — the only reason the SIGKILL escalation exists. */
    private readonly wedged = false,
  ) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.handle(line);
        newline = buffer.indexOf("\n");
      }
    });
  }

  private handle(line: string): void {
    const message = JSON.parse(line) as { id: number; method: string };
    const result = this.respond(message.method);
    // `undefined` means "do not reply", so a test can leave a request hanging.
    if (result === undefined) return;
    const response = `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`;
    setImmediate(() => this.stdout.write(response));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (this.wedged && signal !== "SIGKILL") return true;
    this.exit(null, signal);
    return true;
  }

  /** Ends the fake the way the OS would, leaving `exitCode`/`signalCode` consistent. */
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    // Node always follows `exit` with `close` once the stdio streams are done;
    // a fake that stops at `exit` cannot catch a client that reacts to both.
    this.emit("close", code, signal);
  }

  /**
   * A spawn that never produced a process: Node emits `error` and then `close`,
   * and no `exit` at all. This is the shape of a missing or quarantined helper
   * binary.
   */
  failToSpawn(message: string): void {
    this.emit("error", new Error(message));
    this.emit("close", null, null);
  }
}

function clientWith(
  respond: (method: string) => unknown,
  options: {
    readonly wedged?: boolean;
    readonly maxControlLineBytes?: number;
    readonly onDiagnostic?: (message: string) => void;
  } = {},
): {
  client: MacComputerHelperClient;
  child: FakeChild;
  spawns: FakeChild[];
} {
  const child = new FakeChild(respond, options.wedged ?? false);
  const spawns: FakeChild[] = [];
  const client = new MacComputerHelperClient({
    binaryPath: "/fake/computer-helper",
    // The client only touches stdin/stdout/stderr/on/kill, which the fake has.
    spawn: () => {
      spawns.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    ...(options.maxControlLineBytes === undefined
      ? {}
      : { maxControlLineBytes: options.maxControlLineBytes }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });
  return { client, child, spawns };
}

/** Lets queued stream data and the client's handlers run before an assertion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("MacComputerHelperClient", () => {
  it("correlates a request with its response", async () => {
    const { client } = clientWith((method) =>
      method === "capabilities" ? { screenRecording: true } : { ok: true },
    );
    const result = await client.request("capabilities");
    expect(result).toEqual({ screenRecording: true });
    await client.dispose();
  });

  it("routes request-permissions to the helper under the name it serves", async () => {
    // The wire name is the contract: the backend asks macOS for a missing grant
    // through this method, and a typo here is a silent "method not found" that
    // shows up as "Synara never prompted me".
    const asked: string[] = [];
    const { client } = clientWith((method) => {
      asked.push(method);
      return { accessibility: false, screenRecording: true, protocolVersion: 1 };
    });

    const result = await client.request(MAC_HELPER_METHODS.requestPermissions);

    expect(MAC_HELPER_METHODS.requestPermissions).toBe("request-permissions");
    expect(asked).toEqual(["request-permissions"]);
    // It answers with a capability report, which is what lets the backend cache
    // the post-prompt state instead of guessing at it.
    expect(result).toMatchObject({ accessibility: false, screenRecording: true });
    await client.dispose();
  });

  it("emits the ready notification without treating it as a response", async () => {
    const { client, child } = clientWith(() => ({ ok: true }));
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "ready", params: {} })}\n`);
    // A notification must not settle any request; a following request still works.
    const result = await client.request("ping");
    expect(result).toEqual({ ok: true });
    await client.dispose();
  });

  it("rejects an in-flight request with helper_exited when the process dies", async () => {
    // Returning undefined makes the fake leave the request unanswered, so the
    // exit path is what settles it.
    const { client, child } = clientWith(() => undefined);
    const pending = client.request("list-windows");
    setImmediate(() => child.exit(1, null));
    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MacComputerHelperError);
    expect((error as MacComputerHelperError).code).toBe("helper_exited");
  });

  it("stops running when the spawn failed, and keeps reporting why", async () => {
    const { client, child } = clientWith(() => undefined);
    const pending = client.request("capabilities");
    const settled = pending.catch((value: unknown) => value);
    child.failToSpawn("spawn /fake/computer-helper ENOENT");

    // The in-flight request gets the cause.
    const inFlight = (await settled) as MacComputerHelperError;
    expect(inFlight.code).toBe("helper_spawn_failed");
    expect(inFlight.message).toContain("ENOENT");

    // And the client knows it has no process. Listening only for `exit` — which
    // a failed spawn never emits — left `running` true over a child that does
    // not exist, so the backend went on believing it had a helper and the next
    // request failed as `helper_write_failed`: a fault code that says nothing
    // about the missing binary.
    expect(client.running).toBe(false);
    const later = (await client.request("ping").catch((value: unknown) => value)) as Error;
    expect(later).toBeInstanceOf(MacComputerHelperError);
    expect((later as MacComputerHelperError).code).toBe("helper_spawn_failed");
    expect(later.message).toContain("ENOENT");
    await client.dispose();
  });

  it("reports one termination even though exit and close both fire", async () => {
    const exits: string[] = [];
    const child = new FakeChild(() => undefined);
    const client = new MacComputerHelperClient({
      binaryPath: "/fake/computer-helper",
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
      onExit: (reason) => exits.push(reason),
    });
    client.start();
    child.exit(3, null);
    // A second `onExit` would run the backend's invalidation against a helper it
    // has already replaced.
    expect(exits).toHaveLength(1);
    expect(exits[0]).toContain("code=3");
    await client.dispose();
  });

  it("kills the child when dispose races the start that spawned it", async () => {
    const { client, child } = clientWith(() => ({ ok: true }));
    client.start();
    await client.dispose();
    expect(child.killed).toBe(true);
    expect(client.running).toBe(false);
  });

  it("rejects a request after dispose instead of spawning a replacement helper", async () => {
    const { client, spawns } = clientWith(() => ({ ok: true }));
    await client.request("ping");
    await client.dispose();
    const error = await client.request("ping").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MacComputerHelperError);
    expect((error as MacComputerHelperError).code).toBe("helper_disposed");
    // A respawn here would leak a helper nothing owns or would ever shut down.
    expect(spawns).toHaveLength(1);
  });

  it("fails in-flight requests and names them when a control line is oversized", async () => {
    const diagnostics: string[] = [];
    const { client, child } = clientWith(() => undefined, {
      maxControlLineBytes: 64,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    const pending = client.request("list-windows");
    const settled = pending.catch((value: unknown) => value);
    child.stdout.write(`${"x".repeat(256)}\n`);
    const error = await settled;
    expect(error).toBeInstanceOf(MacComputerHelperError);
    expect((error as MacComputerHelperError).code).toBe("helper_protocol_error");
    // The dropped line took its id with it, so the log is the only record of
    // which request died.
    expect(diagnostics.join("\n")).toContain("list-windows#1");
    expect(diagnostics.join("\n")).toContain("64");
    await client.dispose();
  });

  it("reports an undecodable control line without failing in-flight requests", async () => {
    const diagnostics: string[] = [];
    const { client, child } = clientWith(() => undefined, {
      onDiagnostic: (message) => diagnostics.push(message),
    });
    const pending = client.request("list-windows");
    let settled = false;
    const outcome = pending.then(
      (value: unknown) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    child.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]));
    await flush();
    await flush();
    expect(diagnostics.join("\n")).toContain("invalid-utf8");
    // The framer resynchronized past that one line; the request is still live.
    expect(settled).toBe(false);
    await client.dispose();
    expect((await outcome) as MacComputerHelperError).toBeInstanceOf(MacComputerHelperError);
  });

  it("escalates to SIGKILL when the helper ignores SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const { client, child } = clientWith(() => ({ ok: true }), { wedged: true });
      client.start();
      const disposed = client.dispose();
      expect(child.signals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(HELPER_SHUTDOWN_GRACE_MS);
      await disposed;
      // A leaked helper holds the Accessibility grant and keeps drawing its cursor.
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(child.exitCode === null && child.signalCode === "SIGKILL").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
