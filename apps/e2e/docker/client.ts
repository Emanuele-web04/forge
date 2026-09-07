// FILE: client.ts
// Purpose: The remote side of the local end-to-end run. Runs INSIDE an
// isolated container whose only network path is the relay and the account
// API, and reaches a real Synara host on the developer's machine through the
// relay using the production protocol: device key + PoP registration, grant,
// splice, mint handshake, DPoP authorize, then ordinary Synara RPC traffic.
// Every step prints one JSON line so the orchestrator can render a table;
// the exit code is non-zero if any step failed.
// Layer: E2E tooling (container driver)

import { HOST_SESSION_CLOSE_REVOKED, RELAY_CLOSE_GRANT_REPLAY } from "@synara/relay-protocol";
import { createAccountClient } from "@synara/shared/account";

import { sendFrame } from "../src/harness/websocket";
import { HeadlessClient, type HeadlessClientSession } from "../src/headlessClient";

type Phase = "full" | "reconnect" | "agent";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

const env = {
  apiUrl: required("SYNARA_E2E_API_URL"),
  relayUrl: required("SYNARA_E2E_RELAY_URL"),
  accessToken: required("SYNARA_E2E_ACCESS_TOKEN"),
  userId: required("SYNARA_E2E_USER_ID"),
  hostId: required("SYNARA_E2E_HOST_ID"),
  phase: (process.env.SYNARA_E2E_PHASE ?? "full") as Phase,
  agentModel: process.env.SYNARA_E2E_AGENT_MODEL?.trim() || "claude-sonnet-5",
  agentWorkspaceRoot: process.env.SYNARA_E2E_AGENT_WORKSPACE?.trim() ?? "",
  forbiddenUrls: (process.env.SYNARA_E2E_FORBIDDEN_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
};

let failures = 0;

function report(step: string, ok: boolean, detail: Record<string, unknown> = {}): void {
  if (!ok) failures += 1;
  console.log(JSON.stringify({ step, ok, ...detail }));
}

type StepResult<T> = { ok: boolean; detail?: Record<string, unknown>; value?: T };

async function step<T>(name: string, run: () => Promise<StepResult<T>>): Promise<T | undefined> {
  const startedAt = Date.now();
  try {
    const result = await run();
    report(name, result.ok, { ms: Date.now() - startedAt, ...result.detail });
    return result.value;
  } catch (error) {
    report(name, false, {
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function finish(): never {
  console.log(JSON.stringify({ summary: true, phase: env.phase, failures }));
  process.exit(failures === 0 ? 0 : 1);
}

// ── Production RPC framing over a bridged session ────────────────────
// The host bridges the remote socket into its ordinary /ws RPC server, so the
// frames here are the Effect RPC JSON envelope the web app itself speaks.

type RpcExit = {
  readonly requestId: string;
  readonly success: boolean;
  readonly value: unknown;
};

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function decodeExit(frame: Buffer): RpcExit | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(frame.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!decoded || typeof decoded !== "object") return undefined;
  const envelope = decoded as Record<string, unknown>;
  if (envelope._tag !== "Exit" || typeof envelope.requestId !== "string") return undefined;
  const exit = envelope.exit as Record<string, unknown> | undefined;
  return {
    requestId: envelope.requestId,
    success: exit?._tag === "Success",
    value: exit?._tag === "Success" ? exit.value : exit,
  };
}

let nextRequestId = 1000n;

function waitForExit(
  session: HeadlessClientSession,
  requestId: string,
  timeoutMs: number,
): Promise<RpcExit> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      const exit = decodeExit(toBuffer(data));
      if (!exit || exit.requestId !== requestId) return;
      clearTimeout(timer);
      session.socket.off("message", onMessage);
      resolve(exit);
    };
    const timer = setTimeout(() => {
      session.socket.off("message", onMessage);
      reject(new Error(`timed out waiting for RPC ${requestId}`));
    }, timeoutMs);
    session.socket.on("message", onMessage);
  });
}

async function rpc(
  session: HeadlessClientSession,
  tag: string,
  payload: Record<string, unknown> = {},
  options: { readonly binary?: boolean; readonly timeoutMs?: number } = {},
): Promise<RpcExit> {
  const id = String(nextRequestId++);
  const frame = JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] });
  const reply = waitForExit(session, id, options.timeoutMs ?? 15_000);
  await sendFrame(session.socket, options.binary ? Buffer.from(frame) : frame, options.binary);
  return reply;
}

// ── Streaming RPC over a bridged session ─────────────────────────────
// Effect RPC streams deliver `Chunk` frames and, unless the server disables
// it, WAIT for a client `Ack` before sending the next one. The host keeps
// acks on (it is what bounds the live UI stream), so a subscriber that never
// acks sees exactly one chunk and then silence.

type StreamChunk = { readonly requestId: string; readonly values: readonly unknown[] };

function decodeChunk(frame: Buffer): StreamChunk | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(frame.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!decoded || typeof decoded !== "object") return undefined;
  const envelope = decoded as Record<string, unknown>;
  if (envelope._tag !== "Chunk" || typeof envelope.requestId !== "string") return undefined;
  return {
    requestId: envelope.requestId,
    values: Array.isArray(envelope.values) ? envelope.values : [],
  };
}

type StreamSubscription = {
  readonly items: unknown[];
  /** Resolves when `predicate` matches any item (already received or later). */
  waitFor<T>(predicate: (item: unknown) => T | undefined, timeoutMs: number): Promise<T>;
  end(): Promise<void>;
};

async function subscribe(
  session: HeadlessClientSession,
  tag: string,
  payload: Record<string, unknown>,
): Promise<StreamSubscription> {
  const id = String(nextRequestId++);
  const items: unknown[] = [];
  const waiters = new Set<(item: unknown) => void>();
  let exited: RpcExit | undefined;
  const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buffer = toBuffer(data);
    const chunk = decodeChunk(buffer);
    if (chunk?.requestId === id) {
      for (const value of chunk.values) {
        items.push(value);
        for (const waiter of waiters) waiter(value);
      }
      void sendFrame(session.socket, JSON.stringify({ _tag: "Ack", requestId: id }), false);
      return;
    }
    const exit = decodeExit(buffer);
    if (exit?.requestId === id) exited = exit;
  };
  session.socket.on("message", onMessage);
  await sendFrame(
    session.socket,
    JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }),
    false,
  );
  return {
    items,
    waitFor<T>(predicate: (item: unknown) => T | undefined, timeoutMs: number): Promise<T> {
      for (const item of items) {
        const hit = predicate(item);
        if (hit !== undefined) return Promise.resolve(hit);
      }
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(
            new Error(
              `timed out after ${timeoutMs}ms; stream ${exited ? `exited (${JSON.stringify(exited.value).slice(0, 200)})` : "still open"}; last items: ${JSON.stringify(items.slice(-3)).slice(0, 600)}`,
            ),
          );
        }, timeoutMs);
        const waiter = (item: unknown) => {
          const hit = predicate(item);
          if (hit === undefined) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(hit);
        };
        waiters.add(waiter);
      });
    },
    async end() {
      session.socket.off("message", onMessage);
      await sendFrame(
        session.socket,
        JSON.stringify({ _tag: "Interrupt", requestId: id, interruptors: [] }),
        false,
      );
    },
  };
}

/** Pulls the domain event out of a thread-stream item, or undefined. */
function streamEvent(item: unknown): Record<string, unknown> | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  if (record.kind !== "event" || !record.event || typeof record.event !== "object")
    return undefined;
  return record.event as Record<string, unknown>;
}

// ── Scenarios ─────────────────────────────────────────────────────────

/**
 * A real agent turn through the relay: the production orchestration
 * commands the web composer sends (project → thread → turn), observed on the
 * production thread stream. The model call itself runs on the host, which
 * is the point — the client never holds a provider credential.
 */
const now = () => new Date().toISOString();

async function runAgentTurn(session: HeadlessClientSession): Promise<void> {
  const projectId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const modelSelection = { provider: "claudeAgent", model: env.agentModel };
  const nonce = crypto.randomUUID().slice(0, 8);
  const prompt = `Reply with exactly the text SYNARA-E2E-${nonce} and nothing else. Do not use any tools.`;

  await step("agent: project.create dispatched over the relay", async () => {
    const exit = await rpc(session, "orchestration.dispatchCommand", {
      _tag: "project.create",
      type: "project.create",
      commandId: crypto.randomUUID(),
      projectId,
      title: "E2E relay project",
      workspaceRoot: env.agentWorkspaceRoot,
      defaultModelSelection: modelSelection,
      createdAt: now(),
    });
    return {
      ok: exit.success,
      detail: {
        sequence: (exit.value as { sequence?: number })?.sequence,
        ...(exit.success ? {} : { failure: exit.value }),
      },
    };
  });

  await step("agent: thread.create dispatched over the relay", async () => {
    const exit = await rpc(session, "orchestration.dispatchCommand", {
      _tag: "thread.create",
      type: "thread.create",
      commandId: crypto.randomUUID(),
      threadId,
      projectId,
      title: "E2E relay turn",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: "local",
      branch: null,
      worktreePath: null,
      createdAt: now(),
    });
    return {
      ok: exit.success,
      detail: {
        sequence: (exit.value as { sequence?: number })?.sequence,
        ...(exit.success ? {} : { failure: exit.value }),
      },
    };
  });

  const stream = await step(
    "agent: subscribed to the thread event stream (snapshot received)",
    async () => {
      const subscription = await subscribe(session, "orchestration.subscribeThread", { threadId });
      const snapshot = await subscription.waitFor(
        (item) => ((item as { kind?: string })?.kind === "snapshot" ? item : undefined),
        15_000,
      );
      const thread = (
        snapshot as { snapshot?: { thread?: { id?: string; modelSelection?: unknown } } }
      ).snapshot?.thread;
      return {
        ok: thread?.id === threadId,
        detail: { threadId: thread?.id, modelSelection: thread?.modelSelection },
        value: subscription,
      };
    },
  );
  if (!stream) return;

  const turnStartedAt = Date.now();
  await step(`agent: thread.turn.start dispatched (${env.agentModel})`, async () => {
    const exit = await rpc(session, "orchestration.dispatchCommand", {
      _tag: "thread.turn.start",
      type: "thread.turn.start",
      commandId: crypto.randomUUID(),
      threadId,
      message: { messageId, role: "user", text: prompt, attachments: [] },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now(),
    });
    return {
      ok: exit.success,
      detail: {
        sequence: (exit.value as { sequence?: number })?.sequence,
        ...(exit.success ? {} : { failure: exit.value }),
      },
    };
  });

  await step(
    "agent: host provider session started (thread.session-set → starting/running)",
    async () => {
      const status = await stream.waitFor((item) => {
        const event = streamEvent(item);
        if (event?.type !== "thread.session-set") return undefined;
        const session = (event.payload as { session?: { status?: string } })?.session;
        return session?.status === "starting" ||
          session?.status === "running" ||
          session?.status === "ready"
          ? session.status
          : undefined;
      }, 30_000);
      return { ok: true, detail: { status, ms: Date.now() - turnStartedAt } };
    },
  );

  const assistantText = await step(
    "agent: assistant reply streamed back through the relay",
    async () => {
      // The assistant message arrives as a message-sent event carrying the
      // full text (or the last segment of it); match on the nonce, which the
      // model was told to echo, so a generic "I can't help" would not pass.
      const text = await stream.waitFor((item) => {
        const event = streamEvent(item);
        if (event?.type !== "thread.message-sent") return undefined;
        const payload = event.payload as { role?: string; text?: string };
        return payload.role === "assistant" &&
          typeof payload.text === "string" &&
          payload.text.includes(`SYNARA-E2E-${nonce}`)
          ? payload.text
          : undefined;
      }, 120_000);
      return {
        ok: true,
        detail: { text: text.slice(0, 120), ms: Date.now() - turnStartedAt },
        value: text,
      };
    },
  );

  await step("agent: turn finished — session back to idle with no error", async () => {
    const session = await stream.waitFor((item) => {
      const event = streamEvent(item);
      if (event?.type !== "thread.session-set") return undefined;
      const session = (
        event.payload as {
          session?: { status?: string; activeTurnId?: string | null; lastError?: string | null };
        }
      )?.session;
      return session &&
        session.activeTurnId === null &&
        session.status !== "starting" &&
        session.status !== "running"
        ? session
        : undefined;
    }, 60_000);
    return {
      ok: session.lastError === null || session.lastError === undefined,
      detail: {
        status: session.status,
        lastError: session.lastError,
        totalTurnMs: Date.now() - turnStartedAt,
        assistantChars: assistantText?.length,
      },
    };
  });

  const eventTypes = stream.items
    .map((item) => streamEvent(item)?.type ?? (item as { kind?: string })?.kind)
    .filter(Boolean);
  report("agent: thread stream summary", true, {
    itemsReceived: stream.items.length,
    eventTypes: [...new Set(eventTypes)],
  });
  await stream.end();
}

async function main(): Promise<void> {
  const account = createAccountClient({ baseUrl: env.apiUrl });
  const client = new HeadlessClient({
    apiOrigin: env.apiUrl,
    userId: env.userId,
    accessToken: env.accessToken,
    displayName: `isolated container (${env.phase})`,
    platform: "linux",
  });

  // 0. The isolation claim, proven rather than assumed: every forbidden URL
  //    must fail to connect. The orchestrator separately shows an
  //    unrestricted container CAN reach the same host URL.
  if (env.forbiddenUrls.length > 0) {
    await step("isolation: every forbidden URL is unreachable", async () => {
      const results = await Promise.all(
        env.forbiddenUrls.map(async (url) => {
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
            return { url, reachable: true, status: response.status };
          } catch (error) {
            const code = (error as { code?: string }).code;
            return { url, reachable: false, error: code ?? (error as Error).name };
          }
        }),
      );
      return { ok: results.every((result) => !result.reachable), detail: { results } };
    });
  }

  await step("api reachable: GET /api/v1/instance", async () => {
    const instance = await account.instance();
    return { ok: typeof instance.version === "string", detail: { version: instance.version } };
  });

  const host = await step("host visible to its owner: GET /api/v1/hosts", async () => {
    const { hosts } = await account.listHosts(env.accessToken);
    const match = hosts.find((candidate) => candidate.id === env.hostId);
    return {
      ok: Boolean(match?.linked),
      detail: {
        hosts: hosts.length,
        name: match?.name,
        linked: match?.linked,
        keyGeneration: match?.keyGeneration,
        endpoints: match?.endpoints.map((endpoint) => endpoint.url),
      },
      value: match,
    };
  });
  if (!host) return finish();

  await step("relay reports the host's control socket: GET /healthz/host/:id", async () => {
    const response = await fetch(`${env.relayUrl}/healthz/host/${env.hostId}`);
    const body = (await response.json()) as { ready?: boolean };
    return { ok: body.ready === true, detail: body };
  });

  const device = await step("device registered with proof of possession", async () => {
    const registered = await client.register();
    return {
      ok: registered.jkt.length > 0,
      detail: { deviceId: registered.id, jkt: registered.jkt },
      value: registered,
    };
  });
  if (!device) return finish();

  const grant = await step("single-use grant issued for this device + host", async () => {
    const issued = await client.requestGrant(env.hostId);
    return {
      ok: issued.split(".").length === 3,
      detail: { grantBytes: issued.length },
      value: issued,
    };
  });
  if (!grant) return finish();

  const session = await step("relay session: splice → mint → DPoP authorize → ready", async () => {
    const opened = await client.connectWithGrant({
      candidates: [{ kind: "relay", url: env.relayUrl }],
      environmentId: host.environmentId,
      grant,
    });
    return {
      ok: opened.transport === "relay" && opened.minted,
      detail: {
        transport: opened.transport,
        minted: opened.minted,
        credentialBytes: opened.credential.length,
      },
      value: opened,
    };
  });
  if (!session) return finish();

  await step("production RPC through the relay: server.getEnvironment", async () => {
    const exit = await rpc(session, "server.getEnvironment");
    const descriptor = exit.value as
      | { environmentId?: string; serverVersion?: string; platform?: string; label?: string }
      | undefined;
    return {
      ok: exit.success && descriptor?.environmentId === host.environmentId,
      detail: {
        success: exit.success,
        environmentId: descriptor?.environmentId,
        expected: host.environmentId,
        serverVersion: descriptor?.serverVersion,
        platform: descriptor?.platform,
        label: descriptor?.label,
        ...(exit.success ? {} : { failure: exit.value }),
      },
    };
  });

  await step("production RPC through the relay: server.getConfig", async () => {
    const exit = await rpc(session, "server.getConfig", {}, { timeoutMs: 30_000 });
    const value = exit.value as { cwd?: string; availableEditors?: unknown[] } | undefined;
    return {
      ok: exit.success && typeof value?.cwd === "string",
      detail: {
        success: exit.success,
        cwd: value?.cwd,
        editors: value?.availableEditors?.length,
        ...(exit.success ? {} : { failure: exit.value }),
      },
    };
  });

  await step("binary-framed RPC request traverses the splice intact", async () => {
    const exit = await rpc(session, "server.getEnvironment", {}, { binary: true });
    return { ok: exit.success, detail: { success: exit.success } };
  });

  // The host admits at most 12 concurrent standard requests per connection;
  // stay under that so this measures multiplexing, not the admission limit.
  await step("10 concurrent RPCs multiplex over one splice", async () => {
    const count = 10;
    const replies = await Promise.all(
      Array.from({ length: count }, () =>
        rpc(session, "server.getEnvironment", {}, { timeoutMs: 30_000 }),
      ),
    );
    const ids = new Set(replies.map((reply) => reply.requestId));
    return {
      ok: replies.every((reply) => reply.success) && ids.size === count,
      detail: {
        sent: count,
        succeeded: replies.filter((reply) => reply.success).length,
        distinctIds: ids.size,
      },
    };
  });

  await step("50 sequential RPCs over one splice", async () => {
    let succeeded = 0;
    for (let index = 0; index < 50; index += 1) {
      const exit = await rpc(session, "server.getEnvironment");
      if (exit.success) succeeded += 1;
    }
    return { ok: succeeded === 50, detail: { succeeded } };
  });

  await step("spent grant replay refused with RELAY_CLOSE_GRANT_REPLAY", async () => {
    const replay = await client.openRelay(grant, env.relayUrl);
    const closed = await replay.inbox.waitForClose(10_000);
    return {
      ok: closed.code === RELAY_CLOSE_GRANT_REPLAY && session.socket.readyState === 1,
      detail: {
        code: closed.code,
        expected: RELAY_CLOSE_GRANT_REPLAY,
        reason: closed.reason,
        originalStillOpen: session.socket.readyState === 1,
      },
    };
  });

  if (env.phase === "agent") {
    await runAgentTurn(session);
  }

  if (env.phase === "full") {
    await step("device revocation kills the live session (API → relay → host)", async () => {
      const closed = session.waitForClose(30_000);
      const revokedAt = Date.now();
      await account.revokeDevice(env.accessToken, device.id);
      const close = await closed;
      return {
        ok: close.code === HOST_SESSION_CLOSE_REVOKED,
        detail: {
          code: close.code,
          expected: HOST_SESSION_CLOSE_REVOKED,
          reason: close.reason,
          killLatencyMs: Date.now() - revokedAt,
        },
      };
    });

    await step("revoked device is refused a new grant", async () => {
      try {
        await client.requestGrant(env.hostId);
        return { ok: false, detail: { unexpected: "grant issued to a revoked device" } };
      } catch (error) {
        const status = (error as { status?: number }).status;
        return {
          ok: status !== undefined && status >= 400 && status < 500,
          detail: { status, message: (error as Error).message },
        };
      }
    });
  }

  await session[Symbol.asyncDispose]();
  await client[Symbol.asyncDispose]();
  finish();
}

main().catch((error) => {
  report("fatal", false, {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  finish();
});
