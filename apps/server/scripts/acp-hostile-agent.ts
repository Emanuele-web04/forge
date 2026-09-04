#!/usr/bin/env bun
// FILE: acp-hostile-agent.ts
// Purpose: Deterministic hostile ACP subprocess for the KAR-524 local
// conformance runner. Selectable fault modes via SYNARA_ACP_HOSTILE_* env
// knobs. Each mode is designed to make a real capability verification fail in
// a specific, reproducible way without the agent ever needing to understand
// Synara provider names.
// Layer: Test fixture executable
// Exports: none; communicates over JSON-RPC stdio.

import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";

import * as OfficialAcp from "@agentclientprotocol/sdk";

const mode = process.env.SYNARA_ACP_HOSTILE_MODE ?? "none";
const logPath = process.env.SYNARA_ACP_HOSTILE_LOG_PATH;
const sessionId = process.env.SYNARA_ACP_HOSTILE_SESSION_ID ?? "hostile-session-1";
const advertisedAgentName = process.env.SYNARA_ACP_HOSTILE_AGENT_NAME ?? "hostile-agent";
const advertisedVersion = process.env.SYNARA_ACP_HOSTILE_AGENT_VERSION ?? "1.0.0";
const advertisedAuth = process.env.SYNARA_ACP_HOSTILE_AUTH_METHODS === "1";
const advertisedLoadSession = process.env.SYNARA_ACP_HOSTILE_ADVERTISE_LOAD === "1";
const advertisedResume = process.env.SYNARA_ACP_HOSTILE_ADVERTISE_RESUME === "1";
const advertisedFork = process.env.SYNARA_ACP_HOSTILE_ADVERTISE_FORK === "1";
const advertisedModes = process.env.SYNARA_ACP_HOSTILE_ADVERTISE_MODES === "1";
const advertisedUsage = process.env.SYNARA_ACP_HOSTILE_ADVERTISE_USAGE === "1";
const advertisedConfig = process.env.SYNARA_ACP_HOSTILE_ADVERTISE_CONFIG === "1";
const emulateAuth = process.env.SYNARA_ACP_HOSTILE_AUTH_METHODS === "1";
const promptText = process.env.SYNARA_ACP_HOSTILE_PROMPT_TEXT ?? "hostile says hi";
const hugeOutputBytes = Number(process.env.SYNARA_ACP_HOSTILE_HUGE_OUTPUT_BYTES ?? "64");
const slowBytesPerMs = Number(process.env.SYNARA_ACP_HOSTILE_SLOW_BYTES_PER_MS ?? "1");
const flakyCancelFailFirst = process.env.SYNARA_ACP_HOSTILE_FLAKY_CANCEL_FAIL_FIRST === "1";
const capabilityFlipAfterInitialize = process.env.SYNARA_ACP_HOSTILE_CAPABILITY_FLIP === "1";
const zombieSpawnRetries = 5;

function log(type: string, payload: unknown): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ type, payload })}\n`, "utf8");
  } catch {
    // Logging must never crash the fixture.
  }
}

// Zones the fixture refuses to run in: no synchronous writes to stdout from
// this point on except through the ACP writer, so fault modes stay in control.
const writeStdoutUtf8 = (text: string): void => {
  process.stdout.write(text);
};

let cancelled = false;
let cancelCount = 0;

// ── startup-time modes (before the connection is built) ──────────────────────
if (mode === "initialize-hang") {
  // Connect the SDK as a normal agent but never respond to initialize. The
  // client's startup budget (bounded) must time out and record
  // inconclusive/environment instead of a hard agent failure. Connecting keeps
  // stdin/stdout live so the child stays up for the whole probe; only the
  // initialize handler is withheld (see the initialize handler below).
  log("start", { mode });
}

if (mode === "malformed-frame") {
  log("start", { mode });
  writeStdoutUtf8("{not-json}\n");
}

if (mode === "stdout-pollution") {
  // Garbage that is not JSON and not a frame, before any protocol message.
  // The conformance boundary must attribute the failure to the agent, not
  // silently skip the line.
  log("start", { mode });
  writeStdoutUtf8("random agent chatter\n");
}

if (mode === "zombie-child") {
  // Spawns a long-lived grandchild so the process tree has a descendant. The
  // grandchild ignores SIGTERM; supervised teardown must SIGKILL it.
  log("start", { mode });
  for (let attempt = 0; attempt < zombieSpawnRetries; attempt++) {
    try {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},2**31);"], {
        stdio: "ignore",
        detached: false,
      });
      child.unref();
      log("zombie-child", { pid: child.pid });
      break;
    } catch {
      // Retry transient spawn failures.
    }
  }
}

if (mode === "partial-utf8") {
  // Split a multi-byte code point across two writes without a newline between
  // them, then continue normally.
  log("start", { mode });
  const encoder = new TextEncoder();
  const bytes = encoder.encode("héllo 🎉");
  process.stdout.write(bytes.slice(0, bytes.indexOf(0xf0) + 1));
  process.stdout.write(bytes.slice(bytes.indexOf(0xf0) + 1));
  process.stdout.write("\n");
}

if (mode === "slow-drip") {
  // Drip noise to stderr (never the ACP stdout channel) one dot per tick so an
  // otherwise-healthy agent keeps its protocol stream clean. The conformance
  // boundary must tolerate slow/steady child output without a premature
  // timeout or a corrupt frame.
  log("start", { mode });
  const drip = setInterval(() => {
    process.stderr.write(".");
  }, slowBytesPerMs);
  drip.unref();
}

// ── session/update wiring ─────────────────────────────────────────────────────
interface HostileSessionState {
  sessionId: string;
  promptRequests: number;
}

const state: HostileSessionState = { sessionId, promptRequests: 0 };

function sessionUpdate(context: OfficialAcp.AgentContext) {
  return (update: Record<string, unknown>): Promise<void> =>
    context.notify(OfficialAcp.methods.client.session.update, {
      sessionId: state.sessionId,
      update,
    });
}

function modeState(): OfficialAcp.SessionModeState {
  return {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask", description: "Request permission before changes" },
      { id: "code", name: "Code", description: "Write code" },
    ],
  };
}

function configOptions(): Array<OfficialAcp.SessionConfigOption> {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Auto" },
        { value: "opus-4.8", name: "Opus 4.8" },
      ],
    },
    {
      id: "reasoning",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [{ value: "medium", name: "Medium" }],
    },
  ];
}

function initializeCapabilities(): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
  };
  if (advertisedLoadSession) {
    capabilities.loadSession = true;
  }
  const sessionCapabilities: Record<string, unknown> = {};
  if (advertisedResume) {
    sessionCapabilities.resume = {};
  }
  if (advertisedFork) {
    sessionCapabilities.fork = {};
  }
  capabilities.sessionCapabilities = sessionCapabilities;
  return capabilities;
}

const app = OfficialAcp.agent({
  name: "synara-hostile",
});

app.onRequest(OfficialAcp.methods.agent.initialize, ({ params }) => {
  log("initialize", { params });
  if (mode === "initialize-hang") {
    // Withhold the initialize response entirely; the client must time out.
    return new Promise<never>(() => undefined);
  }
  return {
    protocolVersion: 1,
    agentCapabilities: initializeCapabilities(),
    ...(advertisedAuth ? { authMethods: [{ id: "test", name: "Test auth" }] } : {}),
    agentInfo: { name: advertisedAgentName, version: advertisedVersion },
  };
});

app.onRequest(OfficialAcp.methods.agent.authenticate, () => {
  log("authenticate", {});
  if (emulateAuth) {
    return {};
  }
  throw new OfficialAcp.RequestError(-32602, "authentication required", {
    denied: true,
  });
});

app.onRequest(OfficialAcp.methods.agent.session.new, async ({ client: context }) => {
  log("session/new", { sessionId: state.sessionId });
  if (capabilityFlipAfterInitialize) {
    // The agent advertised resume at initialize but does not actually support
    // it in practice; a resume attempt will fail.
    state.sessionId = `${sessionId}-flipped`;
    return {
      sessionId: state.sessionId,
      modes: modeState(),
      configOptions: configOptions(),
    };
  }
  return {
    sessionId: state.sessionId,
    modes: modeState(),
    configOptions: configOptions(),
  };
});

app.onRequest(OfficialAcp.methods.agent.session.resume, async ({ params }) => {
  log("session/resume", { params });
  if (mode === "fake-resume") {
    // Advertises session/resume support but cannot actually reopen the
    // requested session: refuse the resume outright. The conformance boundary
    // must attribute the broken advertised capability to the agent.
    throw new OfficialAcp.RequestError(-32602, "requested session cannot be resumed", {
      denied: false,
    });
  }
  // Healthy resume echoes the requested id back.
  return {
    sessionId: params.sessionId,
    modes: modeState(),
    configOptions: configOptions(),
  };
});

app.onRequest(OfficialAcp.methods.agent.session.load, async () => {
  log("session/load", {});
  return {
    modes: modeState(),
    configOptions: configOptions(),
  };
});

app.onRequest(OfficialAcp.methods.agent.session.fork, async () => {
  log("session/fork", {});
  return {
    sessionId: `${sessionId}-fork`,
    modes: modeState(),
    configOptions: configOptions(),
  };
});

app.onRequest(OfficialAcp.methods.agent.session.setConfigOption, async ({ params }) => {
  log("session/set_config_option", { params });
  return { configOptions: configOptions() };
});

app.onRequest(OfficialAcp.methods.agent.session.setMode, async ({ params }) => {
  log("session/set_mode", { params });
  return {};
});

app.onNotification(OfficialAcp.methods.agent.session.cancel, async ({ params }) => {
  cancelCount += 1;
  log("session/cancel", { params, cancelCount });
  if (mode === "ignore-cancel") {
    return;
  }
  cancelled = true;
});

app.onRequest(OfficialAcp.methods.agent.session.prompt, async ({ client: context, params }) => {
  const requestId = state.promptRequests++;
  const requestedSessionId = params.sessionId ?? state.sessionId;
  log("session/prompt", { requestId, sessionId: requestedSessionId });
  const notify = sessionUpdate(context);

  if (mode === "process-death") {
    // Die mid-turn with a non-zero status after the request arrives; the
    // conformance runner must observe the turn failed and the process edge.
    process.exit(37);
  }

  if (mode === "huge-tool-output") {
    const bytes = "x".repeat(hugeOutputBytes);
    await notify({
      sessionUpdate: "tool_call",
      toolCallId: "tool-huge-1",
      title: "Tool",
      kind: "execute",
      status: "pending",
      rawInput: { command: ["yes"] },
    });
    await notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-huge-1",
      status: "completed",
      rawOutput: { exitCode: 0, stdout: bytes, stderr: "" },
    });
    return { stopReason: "end_turn" };
  }

  if (mode === "permission-deny-loop") {
    await context.request(OfficialAcp.methods.client.session.requestPermission, {
      sessionId: state.sessionId,
      toolCall: {
        toolCallId: `tool-deny-${requestId}`,
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: { command: ["cat", "secrets"] },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    // Deny loop: request finishes immediately and returns a policy outcome.
    // The client could keep re-prompting but the conformance observation is
    // bounded; emitting one tool call per prompt is enough to exercise the path.
    await notify({
      sessionUpdate: "tool_call",
      toolCallId: `tool-deny-${requestId}`,
      title: "Terminal",
      kind: "execute",
      status: "pending",
      rawInput: { command: ["cat", "secrets"] },
    });
    await notify({
      sessionUpdate: "tool_call_update",
      toolCallId: `tool-deny-${requestId}`,
      status: "completed",
      rawOutput: { exitCode: 1, stdout: "denied", stderr: "permission denied" },
    });
    return { stopReason: "end_turn" };
  }

  if (mode === "stale-ids") {
    // Duplicate/stale IDs: reuse the same tool call id across two different
    // tools and the same content message id across separate turns.
    const toolCallId = "stale-tool-id";
    await notify({
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Terminal",
      kind: "execute",
      status: "pending",
      rawInput: { command: ["echo", "one"] },
    });
    await notify({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput: { exitCode: 0, stdout: "one", stderr: "" },
    });
    await notify({
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Read File",
      kind: "read",
      status: "pending",
      rawInput: { path: "package.json" },
    });
    await notify({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput: { exitCode: 0, stdout: "two", stderr: "" },
    });
    await notify({
      sessionUpdate: "agent_message_chunk",
      messageId: "stale-message-id",
      content: { type: "text", text: promptText },
    });
    await notify({
      sessionUpdate: "agent_message_chunk",
      messageId: "stale-message-id",
      content: { type: "text", text: `${promptText}-again` },
    });
    return { stopReason: "end_turn" };
  }

  if (mode === "late-event-after-close") {
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: promptText },
    });
    return { stopReason: "end_turn" };
  }

  if (mode === "capability-change") {
    // The agent says it supports session/resume at initialize but session/new
    // reports a different session id than the one it later claims to resume.
    const flipped = state.sessionId;
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${promptText} ${flipped}` },
    });
    return { stopReason: "end_turn" };
  }

  if (mode === "ignore-cancel") {
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ignoring your cancel" },
    });
    // Never returns: the prompt hangs until the runner cancels again or times out.
    await new Promise<void>(() => undefined);
    return { stopReason: "cancelled" };
  }

  if (mode === "flaky-cancel") {
    // The first prompt rolls the dice: when flakyCancelFailFirst is set this
    // probe fails for genuinely missing capability; otherwise (and always on
    // later prompts) it behaves like the healthy path — emit cancel-ready and
    // resolve only after the client's session/cancel arrives. The conformance
    // policy must derive a stable degraded (not broken) state from alternating
    // pass/one-fail evidence (AC #4).
    const shouldFail = flakyCancelFailFirst && state.promptRequests === 1;
    if (shouldFail) {
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "flaky failed" },
      });
      throw new OfficialAcp.RequestError(-32603, "flaky capability hiccup", {
        denied: false,
      });
    }
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "cancel-ready" },
    });
    await new Promise<void>((resolve) => {
      if (cancelled) {
        resolve();
        return;
      }
      const timer = setInterval(() => {
        if (cancelled) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
      timer.unref();
    });
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "flaky cancelled" },
    });
    return { stopReason: cancelled ? "cancelled" : "end_turn" };
  }

  // Default: behave like a healthy agent for the capability under test. The
  // conformance cancel probe prompts with "block" and waits for a
  // `cancel-ready` marker before sending session/cancel; only that path blocks
  // for the cancel so every other prompt resolves normally.
  const promptIsBlockProbe =
    params.prompt?.[0]?.type === "text" && params.prompt[0].text === "block";
  await notify({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "cancel-ready" },
  });
  if (cancelled) {
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "cancelled after ready" },
    });
    return { stopReason: "cancelled" };
  }
  if (promptIsBlockProbe) {
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (cancelled) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
      timer.unref();
    });
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "cancelled after ready" },
    });
    return { stopReason: "cancelled" };
  }
  await notify({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: promptText },
  });
  await notify({
    sessionUpdate: "usage_update",
    used: 10,
    size: 100,
  });
  return { stopReason: "end_turn" };
});

// Late event after close: after the client sends session/close (or the stream
// closes), the agent emits one more session/update. The runner must not let a
// post-close event corrupt state.
app.onRequest(OfficialAcp.methods.agent.session.close, async ({ client: context }) => {
  log("session/close", { sessionId: state.sessionId });
  if (mode === "late-event-after-close") {
    await sessionUpdate(context)({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "after-close" },
    });
  }
  return {};
});

app.onRequest("conformance/echo", { parse: (params: unknown) => params }, ({ params }) => {
  log("conformance/echo", { params });
  return { echo: params };
});

process.once("SIGTERM", () => {
  log("sigterm", { mode });
  if (mode === "zombie-child") {
    // Leave the grandchild behind even on a clean SIGTERM — the supervisor
    // must still reap it.
    setInterval(() => undefined, 60_000).unref();
    return;
  }
  process.exit(0);
});

process.once("SIGINT", () => {
  log("sigint", { mode });
  process.exit(0);
});

process.once("exit", (code) => {
  log("exit", { code });
});

const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const connection = app.connect(OfficialAcp.ndJsonStream(output, input));
void connection.closed.then(() => process.exit(0));
