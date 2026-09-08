import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  cuaRequest,
  CUA_DRIVER_VERSION,
  CUA_NATIVE_REVISION,
  CUA_READ_TOOLS,
  CUA_ACTION_TOOLS,
  type CuaReply,
  type CuaToolResult,
} from "@synara/shared/cuaDriverProtocol";

interface Generation {
  child: ChildProcess;
  socket: string;
  session: string;
  exited: Promise<void>;
  didExit: boolean;
  retired: boolean;
  cancellationReady: boolean;
  inputInFlight: boolean;
  retirement?: Promise<void>;
}

/** Lives in Electron's main process. Only this GUI process spawns the native
 * daemon: a bundle-id string sent by a standalone server cannot confer TCC. */
export class CuaDriverHost {
  private directory = "";
  private server: Server | undefined;
  private generation: Generation | undefined;
  private starting: Promise<Generation> | undefined;
  private retiring: Promise<void> = Promise.resolve();
  private closed = false;
  private suspended = false;
  private operations: Promise<void> = Promise.resolve();
  private stopping: Promise<void> = Promise.resolve();
  private epoch = 0;
  private readonly connections = new Set<Socket>();
  constructor(
    private readonly options: {
      binaryPath: string;
      bundleId: string;
      capability: string;
      setup: () => Promise<void>;
      normalizeOverview?: (result: CuaToolResult) => CuaToolResult;
    },
  ) {}

  async listen(): Promise<string> {
    this.directory = await mkdtemp(join(tmpdir(), "synara-cua-"));
    await chmod(this.directory, 0o700);
    const endpoint = join(this.directory, "host.sock");
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    await chmod(endpoint, 0o600);
    return endpoint;
  }

  private accept(socket: Socket): void {
    this.connections.add(socket);
    socket.once("close", () => this.connections.delete(socket));
    socket.on("error", () => undefined);
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        socket.destroy();
        return;
      }
      const end = chunk.indexOf(10);
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end < 0) return;
      socket.removeAllListeners("data");
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!request || typeof request !== "object" || Array.isArray(request))
          throw new Error("Invalid request");
      } catch {
        socket.destroy();
        return;
      }
      void this.handle(request, socket).then(
        (result) => socket.end(JSON.stringify(result) + "\n"),
        (error) =>
          socket.end(
            JSON.stringify({ ok: false, error: String(error), effect: "not-dispatched" }) + "\n",
          ),
      );
    });
    socket.setTimeout(60_000, () => socket.destroy());
  }

  private async handle(request: Record<string, unknown>, connection: Socket): Promise<CuaReply> {
    const supplied =
      typeof request.capability === "string" ? Buffer.from(request.capability) : Buffer.alloc(0);
    const expected = Buffer.from(this.options.capability);
    if (
      expected.length < 32 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new Error("Computer host authority is required.");
    if (request.method === "stop") {
      await this.stop();
      return { ok: true };
    }
    if (this.closed) throw new Error("Computer host is closed.");
    if (this.suspended)
      throw new Error("Computer host is suspended while the backend is stopping.");
    if (request.method === "probe") {
      try {
        await access(this.options.binaryPath);
      } catch {
        return {
          ok: false,
          error:
            "Cua Driver is not bundled. Run the local provisioning script and relaunch Synara.",
        };
      }
      return { ok: true, result: { version: CUA_DRIVER_VERSION, running: !!this.generation } };
    }
    if (request.method === "setup") {
      await this.stop();
      await this.options.setup();
      return { ok: true };
    }
    const name = request.name;
    if (
      request.method !== "call" ||
      typeof name !== "string" ||
      (!CUA_READ_TOOLS.has(name) && !CUA_ACTION_TOOLS.has(name))
    )
      throw new Error("Unsupported computer host request.");
    // Observations and input share one native session. A pane capture must not
    // race input or turn a harmless concurrent read into a driver restart.
    const previous = this.operations;
    const stopping = this.stopping;
    const epoch = this.epoch;
    const operation = (async () => {
      await previous;
      await stopping;
      if (this.closed || this.suspended || connection.destroyed || epoch !== this.epoch)
        return {
          ok: false,
          error: "Cancelled before dispatch.",
          effect: "not-dispatched",
        } as const;
      return this.call(name, request.args, connection);
    })();
    this.operations = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async call(name: string, input: unknown, connection: Socket): Promise<CuaReply> {
    let generation: Generation | undefined;
    let dispatched = false;
    // A failed cleanup remains the admission barrier. Consume this detached
    // rejection here; the next call/stop reports the retained failure.
    const abort = () => {
      if (generation) void this.retire(generation).catch(() => undefined);
    };
    connection.once("close", abort);
    try {
      generation = await this.ensureStarted();
      if (connection.destroyed || generation.retired) throw new Error("Cancelled before dispatch.");
      const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      dispatched = true;
      generation.inputInFlight = CUA_ACTION_TOOLS.has(name);
      const reply = await cuaRequest<CuaReply>(
        generation.socket,
        {
          method: "call",
          name,
          args: { ...args, session: generation.session },
        },
        { timeoutMs: 30_000, mutation: CUA_ACTION_TOOLS.has(name) },
      );
      generation.inputInFlight = false;
      if (name === "get_desktop_state" && reply.result && this.options.normalizeOverview)
        this.options.normalizeOverview(reply.result);
      return reply;
    } catch (error) {
      let detail = String(error);
      if (generation) {
        try {
          await this.retire(generation);
        } catch (cleanupError) {
          detail += `; ${String(cleanupError)}`;
        }
      }
      return {
        ok: false,
        error: detail,
        effect: dispatched && CUA_ACTION_TOOLS.has(name) ? "dispatched-unknown" : "not-dispatched",
      };
    } finally {
      connection.removeListener("close", abort);
    }
  }

  private ensureStarted(): Promise<Generation> {
    if (this.starting) return this.starting;
    const start = async () => {
      await this.retiring;
      if (this.closed) throw new Error("Computer host is closed.");
      if (this.generation && !this.generation.retired && !this.generation.didExit)
        return this.generation;
      if (this.generation) await this.retire(this.generation);
      await access(this.options.binaryPath);
      const endpoint = join(this.directory, `driver-${randomUUID().slice(0, 8)}.sock`);
      const child = spawn(this.options.binaryPath, ["serve", "--embedded", "--socket", endpoint], {
        stdio: ["pipe", "ignore", "pipe"],
        env: {
          ...process.env,
          CUA_DRIVER_EMBEDDED: "1",
          CUA_DRIVER_HOST_BUNDLE_ID: this.options.bundleId,
          CUA_DRIVER_PERMISSION_MODE: "standard",
          CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
          CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
          CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid),
          CUA_DRIVER_RS_HOME: join(this.directory, "state"),
        },
      });
      // Consume diagnostics without retaining potentially private tool payloads.
      child.stderr?.on("data", () => undefined);
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      const generation: Generation = {
        child,
        socket: endpoint,
        session: `synara-${randomUUID()}`,
        exited,
        didExit: false,
        retired: false,
        cancellationReady: false,
        inputInFlight: false,
      };
      this.generation = generation;
      void exited.then(() => {
        generation.didExit = true;
      });
      try {
        let metadata: CuaReply | undefined;
        for (let attempt = 0; attempt < 80; attempt++) {
          if (generation.retired || generation.didExit)
            throw new Error("Cua Driver stopped during startup.");
          try {
            metadata = await cuaRequest<CuaReply>(
              endpoint,
              { method: "metadata" },
              { timeoutMs: 200 },
            );
            break;
          } catch {
            await delay(50);
          }
        }
        if (
          !metadata?.ok ||
          metadata.result?.driver_version !== CUA_DRIVER_VERSION ||
          metadata.result?.synara_native_revision !== CUA_NATIVE_REVISION ||
          metadata.result?.embedded !== true ||
          metadata.result?.pid !== child.pid
        )
          throw new Error("Cua Driver identity/version/native revision handshake failed.");
        if (generation.retired || generation.didExit)
          throw new Error("Cua Driver stopped during startup.");
        generation.cancellationReady = true;
        await chmod(endpoint, 0o600);
        if (generation.retired || generation.didExit)
          throw new Error("Cua Driver stopped during startup.");
        const session = await cuaRequest<CuaReply>(endpoint, {
          method: "call",
          name: "start_session",
          args: { session: generation.session },
        });
        if (!session.ok || session.result?.isError)
          throw new Error("Cua session initialization failed.");
        return generation;
      } catch (error) {
        await this.retire(generation);
        throw error;
      }
    };
    this.starting = start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private retire(generation: Generation): Promise<void> {
    if (generation.retirement) return generation.retirement;
    generation.retired = true;
    this.retiring = this.retiring.then(async () => {
      if (generation.didExit && generation.inputInFlight)
        throw new Error(
          "Cua Driver exited during input without confirming native cleanup. Computer admission is closed.",
        );
      if (!generation.didExit && generation.cancellationReady) {
        const reply = await cuaRequest<CuaReply>(
          generation.socket,
          {
            method: "cancel_input",
            args: { expected_pid: generation.child.pid },
          },
          { timeoutMs: 5_000 },
        );
        const cleanup = reply.result;
        if (
          !reply.ok ||
          cleanup?.pid !== generation.child.pid ||
          cleanup?.input_admission_closed !== true ||
          cleanup?.cleanup_complete !== true ||
          cleanup?.pending_input !== 0
        ) {
          throw new Error(
            "Cua Driver did not confirm native input cleanup. Computer admission is closed; the driver was not killed or replaced.",
          );
        }
        generation.inputInFlight = false;
      }
      // Before the validated handshake no action can have been dispatched.
      // Otherwise the authenticated acknowledgement above covers all matching
      // releases and native context restoration before termination is allowed.
      if (!generation.didExit) {
        // End the lifetime pipe too: Tokio's blocking stdin reader otherwise
        // keeps the native runtime alive during graceful shutdown.
        generation.child.stdin?.end();
        const terminate = setTimeout(() => generation.child.kill("SIGTERM"), 500);
        const force = setTimeout(() => generation.child.kill("SIGKILL"), 1_500);
        try {
          await generation.exited;
        } finally {
          clearTimeout(terminate);
          clearTimeout(force);
        }
      }
      if (this.generation === generation) this.generation = undefined;
      await rm(generation.socket, { force: true });
    });
    generation.retirement = this.retiring;
    return this.retiring;
  }

  stop(): Promise<void> {
    this.epoch += 1;
    const admitted = this.operations;
    this.stopping = this.stopping.then(async () => {
      if (this.generation) await this.retire(this.generation);
      await this.starting?.catch(() => undefined);
      if (this.generation) await this.retire(this.generation);
      await admitted;
      await this.retiring;
    });
    return this.stopping;
  }

  /** Backend shutdown must reject later requests as well as cancel admitted
   * work. Ordinary turn Stop remains reusable without a backend restart. */
  suspend(): Promise<void> {
    this.suspended = true;
    return this.stop();
  }

  resume(): void {
    if (!this.closed) this.suspended = false;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    try {
      await this.stop();
    } finally {
      for (const socket of this.connections) socket.destroy();
      await new Promise<void>((resolve) => {
        if (this.server) this.server.close(() => resolve());
        else resolve();
      });
      if (this.directory && !this.generation)
        await rm(this.directory, { recursive: true, force: true });
    }
  }
}
