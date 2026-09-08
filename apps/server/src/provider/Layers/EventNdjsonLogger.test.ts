import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

function parseLogLine(line: string) {
  const match = /^\[([^\]]+)\] ([A-Z]+): (.+)$/.exec(line);
  assert.notEqual(match, null);
  if (!match) {
    throw new Error(`invalid log line: ${line}`);
  }
  const observedAt = match[1];
  const stream = match[2];
  const payload = match[3];
  if (!observedAt || !stream || payload === undefined) {
    throw new Error(`invalid log line: ${line}`);
  }
  return {
    observedAt,
    stream,
    payload,
  };
}

describe("EventNdjsonLogger", () => {
  it.effect("writes image metadata without persisting model image bodies", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-image-log-"));
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "native.ndjson"), {
          stream: "native",
        });
        assert.isDefined(logger);
        if (!logger) return;
        const data = Buffer.alloc(512 * 1024, 123).toString("base64");
        const image = { type: "image", data, mimeType: "image/png" };
        yield* logger.write({ content: [image] }, ThreadId.makeUnsafe("image-thread"));
        yield* logger.close();
        const line = fs.readFileSync(path.join(tempDir, "image-thread.log"), "utf8").trim();
        const logged = JSON.parse(parseLogLine(line).payload);
        assert.isBelow(line.length, 1000);
        assert.deepEqual(logged.content, [
          {
            type: "image",
            mimeType: "image/png",
            synaraImageOmitted: true,
            encodedLength: data.length,
            byteLength: 512 * 1024,
          },
        ]);
        assert.equal(image.data, data);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("writes effect-style lines to thread-scoped files", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write(
          { threadId: "provider-thread-1", id: "evt-1" },
          ThreadId.makeUnsafe("thread-1"),
        );
        yield* logger.write(
          { type: "turn.completed", threadId: "provider-thread-2", id: "evt-2" },
          ThreadId.makeUnsafe("thread-2"),
        );
        yield* logger.close();

        const threadOnePath = path.join(tempDir, "thread-1.log");
        const threadTwoPath = path.join(tempDir, "thread-2.log");
        assert.equal(fs.existsSync(threadOnePath), true);
        assert.equal(fs.existsSync(threadTwoPath), true);
        if (process.platform !== "win32") {
          assert.equal(fs.statSync(tempDir).mode & 0o777, 0o700);
          assert.equal(fs.statSync(threadOnePath).mode & 0o777, 0o600);
          assert.equal(fs.statSync(threadTwoPath).mode & 0o777, 0o600);
        }

        const first = parseLogLine(fs.readFileSync(threadOnePath, "utf8").trim());
        const second = parseLogLine(fs.readFileSync(threadTwoPath, "utf8").trim());

        assert.equal(Number.isNaN(Date.parse(first.observedAt)), false);
        assert.equal(first.stream, "NTIVE");
        assert.equal(first.payload, '{"threadId":"provider-thread-1","id":"evt-1"}');

        assert.equal(Number.isNaN(Date.parse(second.observedAt)), false);
        assert.equal(second.stream, "NTIVE");
        assert.equal(
          second.payload,
          '{"type":"turn.completed","threadId":"provider-thread-2","id":"evt-2"}',
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "falls back to a global segment when orchestration thread id is missing or invalid",
    () =>
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-log-"));
        const basePath = path.join(tempDir, "provider-canonical.ndjson");

        try {
          const logger = yield* makeEventNdjsonLogger(basePath, { stream: "orchestration" });
          assert.notEqual(logger, undefined);
          if (!logger) {
            return;
          }

          yield* logger.write({ id: "evt-no-thread" }, null);
          yield* logger.write({ id: "evt-invalid-thread" }, "!!!" as unknown as ThreadId);
          yield* logger.close();

          const globalPath = path.join(tempDir, "_global.log");
          assert.equal(fs.existsSync(globalPath), true);
          const lines = fs
            .readFileSync(globalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line));
          assert.equal(lines.length, 2);
          assert.equal(Number.isNaN(Date.parse(lines[0]?.observedAt ?? "")), false);
          assert.equal(Number.isNaN(Date.parse(lines[1]?.observedAt ?? "")), false);
          assert.equal(lines[0]?.stream, "CANON");
          assert.equal(lines[0]?.payload, '{"id":"evt-no-thread"}');
          assert.equal(lines[1]?.stream, "CANON");
          assert.equal(lines[1]?.payload, '{"id":"evt-invalid-thread"}');
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );

  it.effect("rotates per-thread files when max size is exceeded", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          maxBytes: 120,
          maxFiles: 2,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        for (let index = 0; index < 10; index += 1) {
          yield* logger.write(
            {
              threadId: "provider-thread-rotate",
              id: `evt-${index}`,
              payload: "x".repeat(40),
            },
            ThreadId.makeUnsafe("thread-rotate"),
          );
        }
        yield* logger.close();

        const fileStem = "thread-rotate.log";
        const matchingFiles = fs
          .readdirSync(tempDir)
          .filter((entry) => entry === fileStem || entry.startsWith(`${fileStem}.`))
          .toSorted();

        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.1`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === fileStem || entry === `${fileStem}.2`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.3`),
          false,
        );
        if (process.platform !== "win32") {
          for (const entry of matchingFiles) {
            assert.equal(fs.statSync(path.join(tempDir, entry)).mode & 0o777, 0o600);
          }
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
