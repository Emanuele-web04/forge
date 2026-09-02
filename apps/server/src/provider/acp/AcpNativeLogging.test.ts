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

  it("redacts every named secret key class while keeping benign fields", () => {
    const sentinels: Record<string, string> = {
      token: "class-token-SENTINEL",
      accessToken: "class-access-token-SENTINEL",
      refresh_token: "class-refresh-token-SENTINEL",
      sessionToken: "class-session-token-SENTINEL",
      secret: "class-secret-SENTINEL",
      secretKey: "class-secret-key-SENTINEL",
      password: "class-password-SENTINEL",
      passphrase: "class-passphrase-SENTINEL",
      cookie: "class-cookie-SENTINEL",
      privateKey: "class-private-key-SENTINEL",
      credential: "class-credential-SENTINEL",
      credentials: "class-credentials-SENTINEL",
      apiKey: "class-api-key-SENTINEL",
      api_key: "class-api-key-underscore-SENTINEL",
      clientSecret: "class-client-secret-SENTINEL",
      windsurfApiKey: "class-windsurf-api-key-SENTINEL",
      devinApiKey: "class-devin-api-key-SENTINEL",
      cursorAuthToken: "class-cursor-auth-token-SENTINEL",
    };
    const redacted = JSON.stringify(
      redactAcpLogSecrets({
        ...sentinels,
        prompt_tokens: 12,
        total_tokens: 34,
        completion_tokens: 22,
        requestId: "req-123",
        _meta: { model: "claude-sonnet-4-5" },
      }),
    );
    for (const [key, sentinel] of Object.entries(sentinels)) {
      assert.notInclude(redacted, sentinel, `leaked value for key: ${key}`);
    }
    assert.include(redacted, "prompt_tokens");
    assert.include(redacted, "total_tokens");
    assert.include(redacted, "completion_tokens");
    assert.include(redacted, "req-123");
    assert.include(redacted, "claude-sonnet-4-5");
    assert.include(redacted, ACP_LOG_REDACTED_VALUE);
  });

  it("redacts URL credentials and sensitive query parameters", () => {
    const url =
      "https://user:supersecretpass@example.com/api?access_token=query-token-SENTINEL&prompt_tokens=7&total_tokens=8";
    const redacted = String(redactAcpLogSecrets(url));
    assert.notInclude(redacted, "supersecretpass");
    assert.notInclude(redacted, "query-token-SENTINEL");
    assert.include(redacted, "prompt_tokens=7");
    assert.include(redacted, "total_tokens=8");
    assert.include(redacted, ACP_LOG_REDACTED_VALUE);
  });

  it("redacts sensitive keys on custom-prototype objects", () => {
    class CustomConfig {
      readonly apiKey = "custom-proto-api-key-SENTINEL";
      readonly secret = "custom-proto-secret-SENTINEL";
      readonly model = "claude-sonnet-4-5";
      readonly tool = "safe-tool-name";
    }
    const redacted = JSON.stringify(redactAcpLogSecrets({ config: new CustomConfig() }));
    assert.notInclude(redacted, "custom-proto-api-key-SENTINEL");
    assert.notInclude(redacted, "custom-proto-secret-SENTINEL");
    assert.include(redacted, "claude-sonnet-4-5");
    assert.include(redacted, "safe-tool-name");
  });

  it("keeps usage-count tokens and benign headers intact", () => {
    const input = {
      usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
      headers: [
        { name: "Authorization", value: "Bearer header-token-SENTINEL" },
        { name: "Content-Type", value: "application/json" },
      ],
      thread_id: "thread-123",
    };
    const redacted = JSON.stringify(redactAcpLogSecrets(input));
    assert.notInclude(redacted, "header-token-SENTINEL");
    assert.include(redacted, "prompt_tokens");
    assert.include(redacted, "completion_tokens");
    assert.include(redacted, "total_tokens");
    assert.include(redacted, "application/json");
    assert.include(redacted, "thread-123");
  });

  it("redacts env-style assignments and named-value tuples", () => {
    const input = JSON.stringify({
      env: [
        { name: "AWS_SECRET_ACCESS_KEY", value: "env-tuple-SENTINEL" },
        { name: "PORT", value: "8080" },
      ],
      rawEnv: "AWS_SECRET_ACCESS_KEY=env-text-SENTINEL PORT=8080",
    });
    const redacted = String(redactAcpLogSecrets(input));
    assert.notInclude(redacted, "env-tuple-SENTINEL");
    assert.notInclude(redacted, "env-text-SENTINEL");
    assert.include(redacted, "8080");
  });

  it("redacts raw JSON protocol frames as string and bytes", () => {
    const frame = JSON.stringify({
      headers: [{ name: "Authorization", value: "Bearer raw-frame-token-SENTINEL" }],
      env: [{ name: SYNARA_AGENT_GATEWAY_TOKEN_ENV, value: "raw-frame-gateway-SENTINEL" }],
      requestId: "req-frame-1",
    });
    const asString = String(redactAcpLogSecrets(frame));
    assert.notInclude(asString, "raw-frame-token-SENTINEL");
    assert.notInclude(asString, "raw-frame-gateway-SENTINEL");
    assert.include(asString, "req-frame-1");

    const asBytes = new TextEncoder().encode(frame);
    const fromBytes = String(redactAcpLogSecrets(asBytes));
    assert.notInclude(fromBytes, "raw-frame-token-SENTINEL");
    assert.notInclude(fromBytes, "raw-frame-gateway-SENTINEL");
    assert.include(fromBytes, "req-frame-1");
  });
});
