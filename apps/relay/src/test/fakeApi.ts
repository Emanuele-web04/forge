import {
  type ApiSigningPublicJwk,
  GRANT_JWT_TYP,
  HOST_CONNECT_SCOPE,
  RELAY_CONTROL_SCOPE,
  RELAY_TICKET_JWT_TYP,
  type RevocationEvent,
  SYNARA_RELAY_AUDIENCE,
} from "@synara/contracts";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from "jose";

type SigningKey = {
  privateKey: CryptoKey;
  publicJwk: ApiSigningPublicJwk;
};

export type SignOptions = {
  typ: string;
  audience: string;
  subject: string;
  claims?: JWTPayload;
  issuer?: string;
  issuedAt?: number;
  expiresAt?: number;
  jti?: string;
  key?: SigningKey;
  algorithm?: string;
};

async function createSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const exported = await exportJWK(publicKey);
  if (exported.kty !== "OKP" || exported.crv !== "Ed25519" || !exported.x) {
    throw new Error("test signing key was not Ed25519");
  }
  return {
    privateKey,
    publicJwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: exported.x,
      kid: randomUUID(),
      alg: "EdDSA",
      use: "sig",
    },
  };
}

export class FakeApi {
  readonly issuer = "https://accounts.example.test/api/v1";
  readonly serviceToken = "test-relay-service-token";
  readonly revocationRequests: Array<number | undefined> = [];
  jwksRequests = 0;
  jwksFailuresRemaining = 0;
  revocationFailuresRemaining = 0;
  revocationEvents: RevocationEvent[] = [];
  watermark = 0;
  origin = "";

  private server: Server | undefined;
  private signingKey!: SigningKey;
  private publishedKeys: ApiSigningPublicJwk[] = [];

  static async create(): Promise<FakeApi> {
    const api = new FakeApi();
    api.signingKey = await createSigningKey();
    api.publishedKeys = [api.signingKey.publicJwk];
    return api;
  }

  static async start(): Promise<FakeApi> {
    const api = await FakeApi.create();
    await api.listen();
    return api;
  }

  readonly fetch = async (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      typeof input === "string" || input instanceof URL
        ? new Request(input.toString(), init)
        : new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/v1/keys/jwks") {
      this.jwksRequests += 1;
      if (this.jwksFailuresRemaining > 0) {
        this.jwksFailuresRemaining -= 1;
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({ keys: this.publishedKeys });
    }
    if (request.method === "GET" && url.pathname === "/internal/revocations") {
      if (request.headers.get("authorization") !== `Bearer ${this.serviceToken}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const rawAfter = url.searchParams.get("after");
      const after = rawAfter === null ? undefined : Number(rawAfter);
      this.revocationRequests.push(after);
      if (this.revocationFailuresRemaining > 0) {
        this.revocationFailuresRemaining -= 1;
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({
        events:
          after === undefined
            ? this.revocationEvents
            : this.revocationEvents.filter((event) => event.id > after),
        watermark: this.watermark,
      });
    }
    return new Response("not found", { status: 404 });
  };

  private async listen(): Promise<void> {
    this.server = createServer(async (request, response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      }
      const upstream = await this.fetch(
        new URL(request.url ?? "/", this.origin || "http://fake-api"),
        {
          method: request.method ?? "GET",
          headers,
        },
      );
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("fake API did not bind TCP");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async unpublishedKey(): Promise<SigningKey> {
    return createSigningKey();
  }

  publish(key: SigningKey): void {
    this.publishedKeys = [key.publicJwk, ...this.publishedKeys];
  }

  async rotate(): Promise<SigningKey> {
    const key = await createSigningKey();
    this.signingKey = key;
    this.publish(key);
    return key;
  }

  async sign(options: SignOptions): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const key = options.key ?? this.signingKey;
    return new SignJWT(options.claims ?? {})
      .setProtectedHeader({
        alg: options.algorithm ?? "EdDSA",
        typ: options.typ,
        kid: key.publicJwk.kid,
      })
      .setIssuer(options.issuer ?? this.issuer)
      .setSubject(options.subject)
      .setAudience(options.audience)
      .setIssuedAt(options.issuedAt ?? now)
      .setExpirationTime(options.expiresAt ?? now + 60)
      .setJti(options.jti ?? randomUUID())
      .sign(key.privateKey);
  }

  signTicket(input: {
    hostId: string;
    environmentId?: string;
    overrides?: Partial<SignOptions>;
  }): Promise<string> {
    return this.sign({
      typ: RELAY_TICKET_JWT_TYP,
      audience: SYNARA_RELAY_AUDIENCE,
      subject: input.hostId,
      claims: {
        environmentId: input.environmentId ?? "environment-1",
        keyGeneration: 1,
        scope: [RELAY_CONTROL_SCOPE],
      },
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
      ...input.overrides,
    });
  }

  signGrant(input: {
    hostId: string;
    environmentId?: string;
    userId?: string;
    deviceJkt?: string;
    overrides?: Partial<SignOptions>;
  }): Promise<string> {
    return this.sign({
      typ: GRANT_JWT_TYP,
      audience: SYNARA_RELAY_AUDIENCE,
      subject: input.userId ?? "user_1",
      claims: {
        hostId: input.hostId,
        environmentId: input.environmentId ?? "environment-1",
        cnf: { jkt: input.deviceJkt ?? "device-thumbprint" },
        scope: [HOST_CONNECT_SCOPE],
      },
      ...input.overrides,
    });
  }
}
