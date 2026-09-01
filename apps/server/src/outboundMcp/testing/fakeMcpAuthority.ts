import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { Socket } from "node:net";
import { promisify } from "node:util";

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Data, Effect } from "effect";

import type { OutboundMcpCredentialRecord } from "../Services/OutboundMcpCredentials.ts";

const execFileAsync = promisify(execFile);
const MAX_REQUEST_BODY_BYTES = 512 * 1024;

type TlsMaterial = {
  readonly certificate: string;
  readonly privateKey: string;
};

const sharedTlsMaterial = new Map<string, Promise<TlsMaterial>>();

async function generateTlsMaterial(opensslExecutable: string): Promise<TlsMaterial> {
  try {
    await execFileAsync(opensslExecutable, ["version"], {
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    throw new FakeMcpAuthorityError({ category: "tls-tool-unavailable" });
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-fake-mcp-tls-"));
  const certificatePath = path.join(directory, "certificate.pem");
  const privateKeyPath = path.join(directory, "private-key.pem");
  try {
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);
    try {
      await execFileAsync(
        opensslExecutable,
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-sha256",
          "-days",
          "1",
          "-set_serial",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-keyout",
          privateKeyPath,
          "-out",
          certificatePath,
        ],
        { timeout: 10_000, windowsHide: true },
      );
    } catch {
      throw new FakeMcpAuthorityError({ category: "tls-generation" });
    }
    if (process.platform !== "win32") {
      await Promise.all([fs.chmod(certificatePath, 0o600), fs.chmod(privateKeyPath, 0o600)]);
    }
    const [certificate, privateKey] = await Promise.all([
      fs.readFile(certificatePath, "utf8"),
      fs.readFile(privateKeyPath, "utf8"),
    ]);
    return { certificate, privateKey };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function getTlsMaterial(opensslExecutable: string): Promise<TlsMaterial> {
  const current = sharedTlsMaterial.get(opensslExecutable);
  if (current !== undefined) return current;
  const pending = generateTlsMaterial(opensslExecutable);
  sharedTlsMaterial.set(opensslExecutable, pending);
  void pending.catch(() => {
    if (sharedTlsMaterial.get(opensslExecutable) === pending) {
      sharedTlsMaterial.delete(opensslExecutable);
    }
  });
  return pending;
}

export class FakeMcpAuthorityError extends Data.TaggedError("FakeMcpAuthorityError")<{
  readonly category: string;
}> {
  override get message(): string {
    return `Fake MCP authority failed (${this.category}).`;
  }
}

export type FakeMcpTool = {
  readonly name: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly handler: (
    args: Readonly<Record<string, unknown>>,
  ) => CallToolResult | Promise<CallToolResult>;
};

export type FakeMcpAuthorityOptions = {
  readonly tools: ReadonlyArray<FakeMcpTool>;
  readonly catalogPageSize?: number;
  readonly accessTokenTtlMs?: number;
  /**
   * Supported where Node can launch an OpenSSL-compatible executable. The fixture fails closed
   * when it is unavailable; it never skips HTTPS or relaxes certificate verification. POSIX
   * certificate files use owner-only modes; Windows uses the temporary directory's native ACLs.
   */
  readonly opensslExecutable?: string;
};

export type FakeMcpRequestRecord = {
  readonly method: string;
  readonly origin: string;
  readonly pathname: string;
  readonly headers: Readonly<Record<string, "[present]" | "[redacted]">>;
};

export type FakeMcpAuthorityMetrics = {
  readonly registrations: number;
  readonly authorizationCodeExchanges: number;
  readonly pkceVerifications: number;
  readonly refreshRotations: number;
  readonly revocations: number;
  readonly catalogRequests: number;
  readonly toolCalls: number;
  readonly mcpRequests: number;
  readonly activeCredentials: number;
  readonly blockedNonLoopbackRequests: number;
};

export type FakeMcpAuthority = {
  readonly origin: URL;
  readonly endpoint: URL;
  readonly fetch: FetchLike;
  readonly authorize: (
    authorizationUrl: string | URL,
  ) => Effect.Effect<void, FakeMcpAuthorityError>;
  readonly callbackParameters: () => { readonly state: string; readonly code: string };
  readonly expireAccessTokens: () => Effect.Effect<void>;
  readonly attemptCrossClientRefresh: () => Effect.Effect<number, FakeMcpAuthorityError>;
  readonly attemptCrossClientRevocation: () => Effect.Effect<number, FakeMcpAuthorityError>;
  readonly matchesCurrentCredentials: (credentials: OutboundMcpCredentialRecord | null) => boolean;
  readonly metrics: () => FakeMcpAuthorityMetrics;
  readonly requestLog: () => ReadonlyArray<FakeMcpRequestRecord>;
  readonly catalogRequestCursors: () => ReadonlyArray<string | null>;
  readonly close: () => Promise<void>;
};

type RegisteredClient = {
  readonly redirectUris: ReadonlySet<string>;
};

type AuthorizationCodeRecord = {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
};

type AccessTokenRecord = {
  readonly clientId: string;
  readonly expiresAt: number;
  readonly refreshToken: string;
};

type RefreshTokenRecord = {
  readonly accessToken: string;
  readonly clientId: string;
};

type McpSession = {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
};

function safeHeaders(headers: IncomingMessage["headers"]): FakeMcpRequestRecord["headers"] {
  return Object.fromEntries(
    Object.keys(headers)
      .toSorted()
      .map((name) => [name, name === "authorization" ? "[redacted]" : "[present]"] as const),
  );
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.byteLength;
    if (received > MAX_REQUEST_BODY_BYTES) {
      throw new FakeMcpAuthorityError({ category: "request-too-large" });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function trustedHttpsFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  certificate: string,
): Promise<Response> {
  const request = new Request(input, init);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : new Uint8Array(await request.arrayBuffer());

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const outgoing = https.request(
      request.url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        ca: certificate,
        rejectUnauthorized: true,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        incoming.once("error", finishReject);
        incoming.once("end", () => {
          if (settled) return;
          settled = true;
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
          }
          resolve(
            new Response(new Uint8Array(Buffer.concat(chunks)), {
              status: incoming.statusCode ?? 500,
              statusText: incoming.statusMessage,
              headers,
            }),
          );
        });
      },
    );
    const abort = () => {
      outgoing.destroy();
      finishReject(
        request.signal.reason ?? new DOMException("Fixture request aborted.", "AbortError"),
      );
    };
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    outgoing.once("error", finishReject);
    outgoing.once("close", () => request.signal.removeEventListener("abort", abort));
    if (body !== null && body.byteLength > 0) outgoing.write(body);
    outgoing.end();
  });
}

function cursorForPage(page: number): string {
  return `fixture-catalog-page-${page}`;
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function startFakeMcpAuthority(options: FakeMcpAuthorityOptions): Promise<FakeMcpAuthority> {
  const pageSize = options.catalogPageSize ?? Math.max(1, options.tools.length);
  const accessTokenTtlMs = options.accessTokenTtlMs ?? 1_000;
  if (
    options.tools.length === 0 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    !Number.isFinite(accessTokenTtlMs) ||
    accessTokenTtlMs <= 0
  ) {
    throw new FakeMcpAuthorityError({ category: "invalid-options" });
  }

  const tls = await getTlsMaterial(options.opensslExecutable ?? "openssl");
  const requestRecords: FakeMcpRequestRecord[] = [];
  const catalogCursors: Array<string | null> = [];
  const clients = new Map<string, RegisteredClient>();
  const authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  const accessTokens = new Map<string, AccessTokenRecord>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();
  const sessions = new Map<string, McpSession>();
  const sockets = new Set<Socket>();
  const inFlightRequests = new Set<Promise<void>>();
  let callback: { readonly state: string; readonly code: string } | null = null;
  let fakeNow = 0;
  let sequence = 0;
  let registrations = 0;
  let authorizationCodeExchanges = 0;
  let pkceVerifications = 0;
  let refreshRotations = 0;
  let revocations = 0;
  let catalogRequests = 0;
  let toolCalls = 0;
  let mcpRequests = 0;
  let blockedNonLoopbackRequests = 0;
  let closing = false;
  let origin = new URL("https://127.0.0.1/");

  const nextValue = (kind: string): string => {
    sequence += 1;
    return `fixture-${kind}-${sequence}`;
  };

  const removeTokenFamily = (refreshToken: string): void => {
    const family = refreshTokens.get(refreshToken);
    refreshTokens.delete(refreshToken);
    if (family !== undefined) accessTokens.delete(family.accessToken);
  };

  const issueTokens = (
    clientId: string,
  ): {
    readonly access_token: string;
    readonly refresh_token: string;
    readonly token_type: "Bearer";
    readonly expires_in: number;
    readonly scope: "mcp:read";
  } => {
    const accessToken = nextValue("access");
    const refreshToken = nextValue("refresh");
    accessTokens.set(accessToken, {
      clientId,
      expiresAt: fakeNow + accessTokenTtlMs,
      refreshToken,
    });
    refreshTokens.set(refreshToken, { accessToken, clientId });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.ceil(accessTokenTtlMs / 1_000)),
      scope: "mcp:read",
    };
  };

  const makeMcpServer = (): McpServer => {
    const server = new McpServer(
      { name: "synara-fake-mcp-authority", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, (request) => {
      catalogRequests += 1;
      const cursor = request.params?.cursor ?? null;
      catalogCursors.push(cursor);
      let page = 0;
      if (cursor !== null) {
        const matched = /^fixture-catalog-page-(\d+)$/.exec(cursor);
        if (matched === null) {
          throw new FakeMcpAuthorityError({ category: "invalid-catalog-cursor" });
        }
        page = Number(matched[1]);
      }
      const start = page * pageSize;
      const tools = options.tools.slice(start, start + pageSize).map((tool) => {
        const descriptor: {
          name: string;
          inputSchema: Readonly<Record<string, unknown>>;
          outputSchema?: Readonly<Record<string, unknown>>;
        } = {
          name: tool.name,
          inputSchema: tool.inputSchema ?? { type: "object" as const },
        };
        if (tool.outputSchema !== undefined) descriptor.outputSchema = tool.outputSchema;
        return descriptor;
      });
      const nextPage = page + 1;
      return {
        tools,
        ...(nextPage * pageSize < options.tools.length
          ? { nextCursor: cursorForPage(nextPage) }
          : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      toolCalls += 1;
      const tool = options.tools.find(({ name }) => name === request.params.name);
      if (tool === undefined) {
        return {
          isError: true,
          content: [{ type: "text", text: "Unknown fixture tool." }],
        };
      }
      return await tool.handler(request.params.arguments ?? {});
    });
    return server;
  };

  const bearerIsValid = (request: IncomingMessage): boolean => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const accessToken = header.slice("Bearer ".length);
    const current = accessTokens.get(accessToken);
    if (current === undefined || current.expiresAt <= fakeNow) {
      accessTokens.delete(accessToken);
      return false;
    }
    return true;
  };

  const rejectBearer = (response: ServerResponse): void => {
    response.setHeader(
      "www-authenticate",
      `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", origin).href}", error="invalid_token"`,
    );
    writeJson(response, 401, { error: "unauthorized" });
  };

  const handleMcpRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!bearerIsValid(request)) {
      rejectBearer(response);
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 405, {
        jsonrpc: "2.0",
        error: { code: -32_000, message: "Method not allowed." },
        id: null,
      });
      return;
    }

    const sessionIdHeader = request.headers["mcp-session-id"];
    const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
    const body =
      request.method === "POST" ? JSON.parse(String(await readRequestBody(request))) : undefined;
    if (request.method === "POST") mcpRequests += 1;

    if (body !== undefined && isInitializeRequest(body)) {
      let assignedSessionId = "";
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => nextValue("session"),
        enableJsonResponse: true,
        onsessioninitialized: (initializedSessionId) => {
          assignedSessionId = initializedSessionId;
        },
        onsessionclosed: (closedSessionId) => {
          sessions.delete(closedSessionId);
        },
      });
      const server = makeMcpServer();
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- SDK transports expose callback properties, not EventTarget methods.
      transport.onclose = () => {
        if (assignedSessionId !== "") sessions.delete(assignedSessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      if (assignedSessionId !== "") sessions.set(assignedSessionId, { server, transport });
      return;
    }

    if (sessionId === undefined || !sessions.has(sessionId)) {
      writeJson(response, 404, {
        jsonrpc: "2.0",
        error: { code: -32_001, message: "Unknown MCP session." },
        id: null,
      });
      return;
    }
    await sessions.get(sessionId)!.transport.handleRequest(request, response, body);
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", origin);
    requestRecords.push({
      method: request.method ?? "GET",
      origin: origin.origin,
      pathname: requestUrl.pathname,
      headers: safeHeaders(request.headers),
    });

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      writeJson(response, 200, {
        resource: new URL("/mcp", origin).href,
        authorization_servers: [origin.href],
        scopes_supported: ["mcp:read"],
        bearer_methods_supported: ["header"],
      });
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/.well-known/oauth-authorization-server"
    ) {
      writeJson(response, 200, {
        issuer: origin.href,
        authorization_endpoint: new URL("/oauth/authorize", origin).href,
        token_endpoint: new URL("/oauth/token", origin).href,
        registration_endpoint: new URL("/oauth/register", origin).href,
        revocation_endpoint: new URL("/oauth/revoke", origin).href,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp:read"],
      });
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/oauth/register") {
      const metadata = JSON.parse(String(await readRequestBody(request))) as {
        readonly redirect_uris?: ReadonlyArray<unknown>;
        readonly token_endpoint_auth_method?: unknown;
      };
      if (
        !Array.isArray(metadata.redirect_uris) ||
        metadata.redirect_uris.length === 0 ||
        metadata.redirect_uris.some((value) => typeof value !== "string") ||
        metadata.token_endpoint_auth_method !== "none"
      ) {
        writeJson(response, 400, { error: "invalid_client_metadata" });
        return;
      }
      const clientId = nextValue("client");
      clients.set(clientId, {
        redirectUris: new Set(metadata.redirect_uris as ReadonlyArray<string>),
      });
      registrations += 1;
      writeJson(response, 201, {
        ...metadata,
        client_id: clientId,
        client_id_issued_at: 1,
      });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/oauth/authorize") {
      const clientId = requestUrl.searchParams.get("client_id");
      const redirectUri = requestUrl.searchParams.get("redirect_uri");
      const state = requestUrl.searchParams.get("state");
      const codeChallenge = requestUrl.searchParams.get("code_challenge");
      const resource = requestUrl.searchParams.get("resource");
      if (
        requestUrl.searchParams.get("response_type") !== "code" ||
        requestUrl.searchParams.get("code_challenge_method") !== "S256" ||
        clientId === null ||
        redirectUri === null ||
        state === null ||
        codeChallenge === null ||
        resource !== new URL("/mcp", origin).href ||
        !clients.get(clientId)?.redirectUris.has(redirectUri)
      ) {
        writeJson(response, 400, { error: "invalid_request" });
        return;
      }
      const code = nextValue("authorization-code");
      authorizationCodes.set(code, { clientId, codeChallenge, redirectUri });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      response.writeHead(302, { location: location.href, "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/oauth/token") {
      const params = new URLSearchParams(String(await readRequestBody(request)));
      const grantType = params.get("grant_type");
      if (grantType === "authorization_code") {
        const code = params.get("code");
        const record = code === null ? undefined : authorizationCodes.get(code);
        if (code !== null) authorizationCodes.delete(code);
        const verifier = params.get("code_verifier");
        if (
          record === undefined ||
          verifier === null ||
          params.get("client_id") !== record.clientId ||
          params.get("redirect_uri") !== record.redirectUri ||
          params.get("resource") !== new URL("/mcp", origin).href ||
          sha256Base64Url(verifier) !== record.codeChallenge
        ) {
          writeJson(response, 400, { error: "invalid_grant" });
          return;
        }
        authorizationCodeExchanges += 1;
        pkceVerifications += 1;
        writeJson(response, 200, issueTokens(record.clientId));
        return;
      }
      if (grantType === "refresh_token") {
        const refreshToken = params.get("refresh_token");
        const clientId = params.get("client_id");
        if (clientId === null || !clients.has(clientId)) {
          writeJson(response, 401, { error: "invalid_client" });
          return;
        }
        const current = refreshToken === null ? undefined : refreshTokens.get(refreshToken);
        if (current !== undefined && current.clientId !== clientId) {
          writeJson(response, 401, { error: "invalid_client" });
          return;
        }
        if (
          refreshToken === null ||
          current === undefined ||
          params.get("resource") !== new URL("/mcp", origin).href
        ) {
          writeJson(response, 400, { error: "invalid_grant" });
          return;
        }
        removeTokenFamily(refreshToken);
        refreshRotations += 1;
        writeJson(response, 200, issueTokens(current.clientId));
        return;
      }
      writeJson(response, 400, { error: "unsupported_grant_type" });
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/oauth/revoke") {
      const params = new URLSearchParams(String(await readRequestBody(request)));
      const token = params.get("token");
      const clientId = params.get("client_id");
      if (clientId === null || !clients.has(clientId)) {
        writeJson(response, 401, { error: "invalid_client" });
        return;
      }
      const refreshRecord = token === null ? undefined : refreshTokens.get(token);
      const accessRecord = token === null ? undefined : accessTokens.get(token);
      const ownerClientId = refreshRecord?.clientId ?? accessRecord?.clientId;
      if (ownerClientId !== undefined && ownerClientId !== clientId) {
        writeJson(response, 401, { error: "invalid_client" });
        return;
      }
      if (refreshRecord !== undefined && token !== null) {
        removeTokenFamily(token);
        revocations += 1;
      } else if (accessRecord !== undefined) {
        removeTokenFamily(accessRecord.refreshToken);
        revocations += 1;
      }
      writeJson(response, 200, {});
      return;
    }
    if (requestUrl.pathname === "/mcp") {
      await handleMcpRequest(request, response);
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  };

  const server = https.createServer({ key: tls.privateKey, cert: tls.certificate });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("request", (request, response) => {
    const work = handleRequest(request, response).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: "fixture_failure" });
      else response.destroy();
    });
    inFlightRequests.add(work);
    void work.finally(() => inFlightRequests.delete(work));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(new FakeMcpAuthorityError({ category: "listen" }));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.closeAllConnections();
    throw new FakeMcpAuthorityError({ category: "listen" });
  }
  origin = new URL(`https://127.0.0.1:${address.port}/`);
  const endpoint = new URL("/mcp", origin);

  const fixtureFetch: FetchLike = async (input, init) => {
    let target: URL;
    try {
      target = new URL(input instanceof Request ? input.url : input);
    } catch {
      throw new FakeMcpAuthorityError({ category: "invalid-request-url" });
    }
    if (
      target.protocol !== "https:" ||
      target.hostname !== "127.0.0.1" ||
      target.origin !== origin.origin
    ) {
      blockedNonLoopbackRequests += 1;
      throw new FakeMcpAuthorityError({ category: "non-loopback-request" });
    }
    return trustedHttpsFetch(input, init, tls.certificate);
  };

  let competingClientId: string | null = null;
  const getCompetingClientId = async (): Promise<string> => {
    if (competingClientId !== null) return competingClientId;
    const response = await fixtureFetch(new URL("/oauth/register", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Synara fixture adversarial client",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      throw new FakeMcpAuthorityError({ category: "cross-client-probe" });
    }
    const metadata = (await response.json()) as { readonly client_id?: unknown };
    if (typeof metadata.client_id !== "string") {
      throw new FakeMcpAuthorityError({ category: "cross-client-probe" });
    }
    competingClientId = metadata.client_id;
    return competingClientId;
  };

  const crossClientRequest = (pathname: "/oauth/token" | "/oauth/revoke") =>
    Effect.tryPromise({
      try: async () => {
        const refreshToken = refreshTokens.keys().next().value;
        if (typeof refreshToken !== "string") {
          throw new FakeMcpAuthorityError({ category: "cross-client-probe" });
        }
        const clientId = await getCompetingClientId();
        const params =
          pathname === "/oauth/token"
            ? new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: clientId,
                resource: new URL("/mcp", origin).href,
              })
            : new URLSearchParams({ token: refreshToken, client_id: clientId });
        const response = await fixtureFetch(new URL(pathname, origin), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params,
        });
        const status = response.status;
        await response.body?.cancel();
        return status;
      },
      catch: () => new FakeMcpAuthorityError({ category: "cross-client-probe" }),
    });

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.allSettled(
      [...sessions.values()].flatMap(({ server: mcpServer, transport }) => [
        transport.close(),
        mcpServer.close(),
      ]),
    );
    sessions.clear();
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(inFlightRequests);
  };

  return {
    origin,
    endpoint,
    fetch: fixtureFetch,
    authorize: (authorizationUrl) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fixtureFetch(authorizationUrl, {
            method: "GET",
            redirect: "manual",
          });
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (response.status !== 302 || location === null) {
            throw new FakeMcpAuthorityError({ category: "authorization" });
          }
          const callbackUrl = new URL(location);
          const state = callbackUrl.searchParams.get("state");
          const code = callbackUrl.searchParams.get("code");
          if (
            callbackUrl.protocol !== "http:" ||
            callbackUrl.hostname !== "127.0.0.1" ||
            state === null ||
            code === null
          ) {
            throw new FakeMcpAuthorityError({ category: "authorization" });
          }
          callback = { state, code };
        },
        catch: () => new FakeMcpAuthorityError({ category: "authorization" }),
      }),
    callbackParameters: () => {
      if (callback === null) {
        throw new FakeMcpAuthorityError({ category: "authorization" });
      }
      return callback;
    },
    expireAccessTokens: () =>
      Effect.sync(() => {
        fakeNow += accessTokenTtlMs;
      }),
    attemptCrossClientRefresh: () => crossClientRequest("/oauth/token"),
    attemptCrossClientRevocation: () => crossClientRequest("/oauth/revoke"),
    matchesCurrentCredentials: (credentials) => {
      const accessToken = credentials?.tokens?.access_token;
      const refreshToken = credentials?.tokens?.refresh_token;
      const accessRecord = accessToken === undefined ? undefined : accessTokens.get(accessToken);
      const refreshRecord =
        refreshToken === undefined ? undefined : refreshTokens.get(refreshToken);
      return (
        accessToken !== undefined &&
        refreshToken !== undefined &&
        accessRecord !== undefined &&
        refreshRecord !== undefined &&
        accessRecord.refreshToken === refreshToken &&
        refreshRecord.accessToken === accessToken &&
        accessRecord.clientId === refreshRecord.clientId
      );
    },
    metrics: () => ({
      registrations,
      authorizationCodeExchanges,
      pkceVerifications,
      refreshRotations,
      revocations,
      catalogRequests,
      toolCalls,
      mcpRequests,
      activeCredentials: accessTokens.size + refreshTokens.size,
      blockedNonLoopbackRequests,
    }),
    requestLog: () =>
      requestRecords.map((record) => ({
        method: record.method,
        origin: record.origin,
        pathname: record.pathname,
        headers: Object.fromEntries(Object.entries(record.headers)),
      })),
    catalogRequestCursors: () => [...catalogCursors],
    close,
  };
}

export function makeFakeMcpAuthority(
  options: FakeMcpAuthorityOptions,
): Effect.Effect<FakeMcpAuthority, FakeMcpAuthorityError, never> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => startFakeMcpAuthority(options),
      catch: (cause) =>
        cause instanceof FakeMcpAuthorityError
          ? cause
          : new FakeMcpAuthorityError({ category: "startup" }),
    }),
    (authority) => Effect.promise(() => authority.close()),
  );
}
