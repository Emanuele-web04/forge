import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OutboundMcpCredentials } from "../Services/OutboundMcpCredentials.ts";
import {
  credentialPath,
  makeOutboundMcpCredentialsLive,
} from "./OutboundMcpCredentials.ts";

const temporaryDirectories = new Set<string>();

async function makeTemporaryHome(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-outbound-mcp-"));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("OutboundMcpCredentials", () => {
  it.skipIf(process.platform === "win32")(
    "atomically stores OAuth credentials in owner-only paths",
    async () => {
      const homeDir = await makeTemporaryHome();
      const credentialsFile = credentialPath(homeDir, "paraty");
      const credentialsDirectory = path.dirname(credentialsFile);
      const stored = {
        clientInformation: {
          client_id: "registered-client",
          client_secret: "client-secret",
        },
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        },
        authorizationServerUrl: "https://auth.paraty.example/",
      } as const;

      await Effect.runPromise(
        Effect.gen(function* () {
          const credentials = yield* OutboundMcpCredentials;
          yield* credentials.write("paraty", stored);
          expect(yield* credentials.read("paraty")).toEqual(stored);

          yield* credentials.write("paraty", {
            ...stored,
            tokens: { ...stored.tokens, access_token: "rotated-token" },
          });
        }).pipe(
          Effect.provide(makeOutboundMcpCredentialsLive(homeDir)),
          Effect.provide(NodeServices.layer),
        ),
      );

      expect((await fs.stat(credentialsDirectory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(credentialsFile)).mode & 0o777).toBe(0o600);
      expect((await fs.readdir(credentialsDirectory)).sort()).toEqual(["paraty.json"]);
      expect(JSON.parse(await fs.readFile(credentialsFile, "utf8"))).toMatchObject({
        tokens: { access_token: "rotated-token" },
      });
    },
  );

  it("removes persisted attempt-only fields without deleting reusable credentials", async () => {
    const homeDir = await makeTemporaryHome();
    const credentialsFile = credentialPath(homeDir, "paraty");
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(
      credentialsFile,
      JSON.stringify({
        clientInformation: { client_id: "registered-client" },
        tokens: { access_token: "access-token", token_type: "Bearer" },
        authorizationCode: "authorization-code",
        codeVerifier: "pkce-verifier",
      }),
      { mode: 0o600 },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* OutboundMcpCredentials;
        yield* credentials.clearAttemptSecrets("paraty");
        expect(yield* credentials.read("paraty")).toEqual({
          clientInformation: { client_id: "registered-client" },
          tokens: { access_token: "access-token", token_type: "Bearer" },
        });
      }).pipe(
        Effect.provide(makeOutboundMcpCredentialsLive(homeDir)),
        Effect.provide(NodeServices.layer),
      ),
    );

    const serialized = await fs.readFile(credentialsFile, "utf8");
    expect(serialized).not.toContain("authorization-code");
    expect(serialized).not.toContain("pkce-verifier");
    expect(serialized).toContain("access-token");
  });

  it("rejects path traversal before joining a credential path", async () => {
    const homeDir = await makeTemporaryHome();

    expect(() => credentialPath(homeDir, "../outside")).toThrow(/connection id/i);
    expect(() => credentialPath(homeDir, "UPPERCASE")).toThrow(/connection id/i);
    await expect(fs.stat(path.join(homeDir, "outside.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns a typed failure for an invalid service connection id", async () => {
    const homeDir = await makeTemporaryHome();

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* OutboundMcpCredentials;
        return yield* Effect.flip(credentials.read("../outside"));
      }).pipe(
        Effect.provide(makeOutboundMcpCredentialsLive(homeDir)),
        Effect.provide(NodeServices.layer),
      ),
    );

    expect(error).toMatchObject({
      _tag: "OutboundMcpCredentialsError",
      operation: "read",
      category: "invalid-connection-id",
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses credential files readable by other users",
    async () => {
      const homeDir = await makeTemporaryHome();
      const credentialsFile = credentialPath(homeDir, "paraty");
      await fs.mkdir(path.dirname(credentialsFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        credentialsFile,
        JSON.stringify({ tokens: { access_token: "access-token", token_type: "Bearer" } }),
        { mode: 0o644 },
      );

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const credentials = yield* OutboundMcpCredentials;
          return yield* Effect.flip(credentials.read("paraty"));
        }).pipe(
          Effect.provide(makeOutboundMcpCredentialsLive(homeDir)),
          Effect.provide(NodeServices.layer),
        ),
      );

      expect(error).toMatchObject({ operation: "read", category: "filesystem" });
      expect(JSON.stringify(error)).not.toContain("access-token");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked credential file without reading its target",
    async () => {
      const homeDir = await makeTemporaryHome();
      const credentialsFile = credentialPath(homeDir, "paraty");
      const outsideFile = path.join(homeDir, "outside.json");
      await fs.mkdir(path.dirname(credentialsFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        outsideFile,
        JSON.stringify({ tokens: { access_token: "access-token", token_type: "Bearer" } }),
        { mode: 0o600 },
      );
      await fs.symlink(outsideFile, credentialsFile);

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const credentials = yield* OutboundMcpCredentials;
          return yield* Effect.flip(credentials.read("paraty"));
        }).pipe(
          Effect.provide(makeOutboundMcpCredentialsLive(homeDir)),
          Effect.provide(NodeServices.layer),
        ),
      );

      expect(error).toMatchObject({ operation: "read", category: "filesystem" });
      expect(await fs.readFile(outsideFile, "utf8")).toContain("access-token");
    },
  );

  it("deletes credentials idempotently and returns null when absent", async () => {
    const homeDir = await makeTemporaryHome();

    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* OutboundMcpCredentials;
        expect(yield* credentials.read("paraty")).toBeNull();
        yield* credentials.write("paraty", {
          tokens: { access_token: "access-token", token_type: "Bearer" },
        });
        yield* credentials.delete("paraty");
        yield* credentials.delete("paraty");
        expect(yield* credentials.read("paraty")).toBeNull();
      }).pipe(
        Effect.provide(makeOutboundMcpCredentialsLive(homeDir)),
        Effect.provide(NodeServices.layer),
      ),
    );
  });

  it("formats malformed credential failures without including file contents", async () => {
    const homeDir = await makeTemporaryHome();
    const credentialsFile = credentialPath(homeDir, "paraty");
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
    await fs.writeFile(
      credentialsFile,
      '{"tokens":{"access_token":"access-token","refresh_token":"refresh-token"}',
      { mode: 0o600 },
    );

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* OutboundMcpCredentials;
        return yield* Effect.flip(credentials.read("paraty"));
      }).pipe(
        Effect.provide(makeOutboundMcpCredentialsLive(homeDir)),
        Effect.provide(NodeServices.layer),
      ),
    );

    expect(error.message).toMatch(/failed to read outbound mcp credentials/i);
    expect(JSON.stringify(error)).not.toContain("access-token");
    expect(JSON.stringify(error)).not.toContain("refresh-token");
  });
});
