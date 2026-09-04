import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Effect, FileSystem, Layer } from "effect";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import {
  ensurePrivateDirectorySync,
  PRIVATE_FILE_MODE,
} from "../../privatePathPermissions.ts";
import {
  OutboundMcpCredentials,
  OutboundMcpCredentialsError,
  type OutboundMcpCredentialRecord,
  type OutboundMcpCredentialsShape,
} from "../Services/OutboundMcpCredentials.ts";

const CONNECTION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type CredentialOperation = OutboundMcpCredentialsError["operation"];

class InvalidConnectionIdError extends Error {}
class InvalidCredentialsError extends Error {}

function credentialError(
  operation: CredentialOperation,
  cause: unknown,
): OutboundMcpCredentialsError {
  const category =
    cause instanceof InvalidConnectionIdError
      ? "invalid-connection-id"
      : cause instanceof InvalidCredentialsError
        ? "invalid-credentials"
        : "filesystem";
  return new OutboundMcpCredentialsError({ operation, category });
}

export function credentialPath(homeDir: string, connectionId: string): string {
  if (!CONNECTION_ID_PATTERN.test(connectionId)) {
    throw new InvalidConnectionIdError("Invalid outbound MCP connection id.");
  }
  return path.join(homeDir, "mcp", "connections", `${connectionId}.json`);
}

function parseClientInformation(value: unknown): OAuthClientInformationMixed | undefined {
  if (value === undefined) return undefined;
  const full = OAuthClientInformationFullSchema.safeParse(value);
  if (full.success) return full.data;
  const basic = OAuthClientInformationSchema.safeParse(value);
  if (basic.success) return basic.data;
  throw new InvalidCredentialsError("Invalid OAuth client information.");
}

function parseCredentialRecord(value: unknown): OutboundMcpCredentialRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidCredentialsError("Invalid outbound MCP credential document.");
  }
  const record = value as Record<string, unknown>;
  const clientInformation = parseClientInformation(record.clientInformation);
  const parsedTokens =
    record.tokens === undefined ? undefined : OAuthTokensSchema.safeParse(record.tokens);
  if (parsedTokens !== undefined && !parsedTokens.success) {
    throw new InvalidCredentialsError("Invalid OAuth tokens.");
  }
  if (
    record.authorizationServerUrl !== undefined &&
    typeof record.authorizationServerUrl !== "string"
  ) {
    throw new InvalidCredentialsError("Invalid authorization server URL.");
  }

  return {
    ...(clientInformation === undefined ? {} : { clientInformation }),
    ...(parsedTokens === undefined ? {} : { tokens: parsedTokens.data }),
    ...(record.authorizationServerUrl === undefined
      ? {}
      : { authorizationServerUrl: record.authorizationServerUrl }),
  };
}

async function readPrivateCredentialFile(
  target: string,
  platform: NodeJS.Platform,
): Promise<string> {
  if (platform === "win32") {
    const pathStat = await fs.lstat(target);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new Error("Unsafe outbound MCP credential path.");
    }
  }

  const noFollowFlag = platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await fs.open(target, fsConstants.O_RDONLY | noFollowFlag);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Outbound MCP credential path is not a regular file.");
    }
    if (platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("Outbound MCP credential file is accessible by other users.");
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

const makeOutboundMcpCredentials = (
  homeDir: string,
  platform: NodeJS.Platform,
): Effect.Effect<OutboundMcpCredentialsShape, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    if (platform === "win32") {
      yield* Effect.logWarning(
        "Outbound MCP credentials use the local Synara profile on Windows; POSIX file modes cannot be enforced on this platform.",
      );
    }

    const resolvePath = (connectionId: string) =>
      Effect.try({
        try: () => credentialPath(homeDir, connectionId),
        catch: (cause) => cause,
      });

    const read: OutboundMcpCredentialsShape["read"] = (connectionId) =>
      Effect.gen(function* () {
        const target = yield* resolvePath(connectionId);
        if (!(yield* fileSystem.exists(target))) return null;
        const serialized = yield* Effect.tryPromise({
          try: () => readPrivateCredentialFile(target, platform),
          catch: (cause) => cause,
        });
        return yield* Effect.try({
          try: () => parseCredentialRecord(JSON.parse(serialized)),
          catch: (cause) =>
            cause instanceof InvalidCredentialsError
              ? cause
              : new InvalidCredentialsError("Invalid credential JSON."),
        });
      }).pipe(Effect.mapError((cause) => credentialError("read", cause)));

    const write: OutboundMcpCredentialsShape["write"] = (connectionId, credentials) =>
      Effect.gen(function* () {
        const target = yield* resolvePath(connectionId);
        const sanitized = yield* Effect.try({
          try: () => parseCredentialRecord(credentials),
          catch: (cause) => cause,
        });
        yield* Effect.try({
          try: () => {
            const credentialsDirectory = path.dirname(target);
            ensurePrivateDirectorySync(path.dirname(credentialsDirectory), platform);
            ensurePrivateDirectorySync(credentialsDirectory, platform);
          },
          catch: (cause) => cause,
        });
        yield* writeFileStringAtomically({
          filePath: target,
          contents: `${JSON.stringify(sanitized, null, 2)}\n`,
          mode: PRIVATE_FILE_MODE,
        });
        if (platform !== "win32") {
          yield* fileSystem.chmod(target, PRIVATE_FILE_MODE);
        }
      }).pipe(Effect.mapError((cause) => credentialError("write", cause)));

    const deleteCredentials: OutboundMcpCredentialsShape["delete"] = (connectionId) =>
      Effect.gen(function* () {
        const target = yield* resolvePath(connectionId);
        yield* fileSystem.remove(target, { force: true });
      }).pipe(Effect.mapError((cause) => credentialError("delete", cause)));

    const clearAttemptSecrets: OutboundMcpCredentialsShape["clearAttemptSecrets"] = (
      connectionId,
    ) =>
      read(connectionId).pipe(
        Effect.flatMap((credentials) =>
          credentials === null ? Effect.void : write(connectionId, credentials),
        ),
        Effect.mapError(
          (cause) =>
            new OutboundMcpCredentialsError({
              operation: "clearAttemptSecrets",
              category: cause.category,
            }),
        ),
      );

    return { read, write, delete: deleteCredentials, clearAttemptSecrets };
  });

export function makeOutboundMcpCredentialsLive(
  homeDir: string,
  options?: { readonly platform?: NodeJS.Platform },
) {
  return Layer.effect(
    OutboundMcpCredentials,
    makeOutboundMcpCredentials(homeDir, options?.platform ?? process.platform),
  );
}

export const OutboundMcpCredentialsLive = Layer.effect(
  OutboundMcpCredentials,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeOutboundMcpCredentials(config.baseDir, process.platform);
  }),
);
