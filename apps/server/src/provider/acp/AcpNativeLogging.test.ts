import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect } from "effect";

import { SYNARA_AGENT_GATEWAY_TOKEN_ENV } from "../../agentGateway/mcpInjection.ts";
import { makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import {
  ACP_LOG_REDACTED_VALUE,
  makeAcpNativeLoggers,
  redactAcpLogSecrets,
} from "./AcpNativeLogging.ts";

describe("AcpNativeLogging", () => {
  it.effect("redacts gateway credentials from request and protocol NDJSON logs", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-acp-secret-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");
      const threadId = ThreadId.makeUnsafe("thread-secret-redaction");
      const sentinelToken = "sagw_session_SENTINEL_MUST_NEVER_REACH_NDJSON";
      const sentinelApiKey = "windsurf_api_key_SENTINEL_MUST_NEVER_REACH_NDJSON";
      const sentinelRawApiKey = "windsurf_raw_api_key_SENTINEL_MUST_NEVER_REACH_NDJSON";

      try {
        const nativeEventLogger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          batchWindowMs: 0,
        });
        assert.notEqual(nativeEventLogger, undefined);
        if (!nativeEventLogger) return;

        const loggers = makeAcpNativeLoggers({
          nativeEventLogger,
          provider: "cursor",
          threadId,
        });
        const requestLogger = loggers.requestLogger;
        const protocolLogger = loggers.protocolLogging?.logger;
        assert.notEqual(requestLogger, undefined);
        assert.notEqual(protocolLogger, undefined);
        if (!requestLogger || !protocolLogger) return;

        yield* requestLogger({
          method: "session/new",
          status: "started",
          payload: {
            _meta: { api_key: sentinelApiKey },
            mcpServers: [
              {
                type: "http",
                headers: [
                  { name: "Authorization", value: `Bearer ${sentinelToken}` },
                  { name: "X-Safe", value: "kept" },
                ],
              },
              {
                env: [
                  { name: SYNARA_AGENT_GATEWAY_TOKEN_ENV, value: sentinelToken },
                  { name: "SAFE_ENV", value: "kept" },
                ],
              },
            ],
          },
        });

        yield* protocolLogger({
          direction: "outgoing",
          stage: "raw",
          payload: JSON.stringify({
            headers: [{ name: "Authorization", value: `Bearer ${sentinelToken}` }],
            env: [{ name: SYNARA_AGENT_GATEWAY_TOKEN_ENV, value: sentinelToken }],
          }),
        });
        yield* protocolLogger({
          direction: "outgoing",
          stage: "raw",
          payload: new TextEncoder().encode(JSON.stringify({ api_key: sentinelRawApiKey })),
        });
        yield* nativeEventLogger.close();

        const logPath = path.join(tempDir, `${threadId}.log`);
        const written = fs.readFileSync(logPath, "utf8");
        assert.notInclude(written, sentinelToken);
        assert.notInclude(written, sentinelApiKey);
        assert.notInclude(written, sentinelRawApiKey);
        assert.include(written, ACP_LOG_REDACTED_VALUE);
        assert.include(written, "X-Safe");
        assert.include(written, "SAFE_ENV");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("redactAcpLogSecrets", () => {
  it("redacts camelCase api keys in colon-quoted JSON values", () => {
    const input = JSON.stringify({
      apiKey: "sk-camel-quoted-sentinel",
      devinApiKey: "sk-devin-camel-sentinel",
      windsurfApiKey: "sk-windsurf-camel-sentinel",
    });
    const redacted = String(redactAcpLogSecrets(input));
    assert.notInclude(redacted, "sk-camel-quoted-sentinel");
    assert.notInclude(redacted, "sk-devin-camel-sentinel");
    assert.notInclude(redacted, "sk-windsurf-camel-sentinel");
    assert.equal((redacted.match(/\[REDACTED\]/g) ?? []).length, 3);
  });

  it("redacts secrets from Cause.pretty output", () => {
    const cause = Cause.fail("request failed: Authorization: Bearer sk-cause-pretty-sentinel");
    const redacted = String(redactAcpLogSecrets(Cause.pretty(cause)));
    assert.notInclude(redacted, "sk-cause-pretty-sentinel");
    assert.include(redacted, ACP_LOG_REDACTED_VALUE);
  });
});
