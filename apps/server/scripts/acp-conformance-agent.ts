#!/usr/bin/env bun
// Official-SDK ACP subprocess used only by the transport conformance suite.

import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { z } from "zod";

const sessionId = "official-sdk-session-1";
const logPath = process.env.SYNARA_ACP_CONFORMANCE_LOG_PATH;
const malformedPrefix = process.env.SYNARA_ACP_CONFORMANCE_MALFORMED_PREFIX === "1";
const noAuthentication = process.env.SYNARA_ACP_CONFORMANCE_NO_AUTH === "1";

function log(type: string, payload: unknown): void {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ type, payload })}\n`, "utf8");
  }
}

let finishCancelledPrompt: (() => void) | undefined;

process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));

if (malformedPrefix) {
  process.stdout.write("{not-json}\n");
}

const app = agent({ name: "synara-official-sdk-conformance-agent" })
  .onRequest(methods.agent.initialize, (ctx) => {
    log("initialize", ctx.params);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: noAuthentication ? [] : [{ id: "test", name: "Test authentication" }],
      agentInfo: { name: "official-sdk-conformance-agent", version: "1.0.0" },
      _meta: {
        primitive: "initialize-meta",
        nested: { source: "official-sdk" },
      },
    };
  })
  .onRequest(methods.agent.authenticate, (ctx) => {
    log("authenticate", ctx.params);
    return {};
  })
  .onRequest(methods.agent.session.new, async (ctx) => {
    log("session/new", ctx.params);
    if (noAuthentication) {
      // The no-auth conformance case only needs to prove the startup request
      // sequence. Exit independently so Windows process-tree teardown does not
      // depend on signal delivery semantics in the test runner.
      setTimeout(() => process.exit(0), 250);
    }
    await ctx.client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "early-new" },
      },
    });
    return {
      sessionId,
      _meta: {
        primitive: 7,
        nested: { phase: "new" },
      },
    };
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    log("session/prompt", ctx.params);
    const shouldWaitForCancel =
      ctx.params.prompt[0]?.type === "text" && ctx.params.prompt[0].text === "wait-for-cancel";

    if (shouldWaitForCancel) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "cancel-ready" },
        },
      });
      await new Promise<void>((resolve) => {
        finishCancelledPrompt = resolve;
      });
      return { stopReason: "cancelled" };
    }

    for (const text of ["prompt-one", "prompt-two"]) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    }
    return { stopReason: "end_turn" };
  })
  .onNotification(methods.agent.session.cancel, (ctx) => {
    log("session/cancel", ctx.params);
    finishCancelledPrompt?.();
    finishCancelledPrompt = undefined;
  })
  .onRequest("conformance/echo", z.unknown(), (ctx) => {
    log("conformance/echo", ctx.params);
    return {
      echo: ctx.params,
      _meta: {
        primitive: true,
        nested: { source: "official-sdk" },
      },
    };
  })
  .onNotification("conformance/notice", z.unknown(), (ctx) => {
    log("conformance/notice", ctx.params);
  })
  .onRequest("conformance/wait-for-generic-cancel", z.unknown(), async (ctx) => {
    log("conformance/wait-for-generic-cancel", ctx.params);
    await ctx.client.notify("conformance/generic-cancel-ready", {});
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) {
        resolve();
        return;
      }
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    log("conformance/generic-cancel-observed", null);
    await ctx.client.notify("conformance/generic-cancel-observed", {});
    return { cancelled: true };
  })
  .onRequest("conformance/exit", z.unknown(), () => {
    log("conformance/exit", null);
    process.exit(17);
  });

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const connection = app.connect(ndJsonStream(output, input));

void connection.closed.then(() => process.exit(0));
