import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeWorkos, type FakeWorkos } from "./testing/fakeWorkos";
import { createWorkosAuth } from "./workos";

let workos: FakeWorkos;

beforeAll(async () => {
  workos = await startFakeWorkos();
});

afterAll(async () => {
  await workos.close();
});

/** The metadata document the service fetches on its first verification. */
function discoveryPath(clientId: string): string {
  return `/user_management/${clientId}/.well-known/openid-configuration`;
}

describe("verifyAccessToken", () => {
  it("returns the user and session ids from a valid token", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({ sub: "user_123", sid: "session_456" });
    await expect(auth.verifyAccessToken(token)).resolves.toEqual({
      userId: "user_123",
      sessionId: "session_456",
    });
  });

  it("rejects an expired token", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({
      sub: "user_123",
      sid: "session_456",
      expiresIn: "-1s",
    });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });

  it("rejects a token signed by a key the JWKS does not publish", async () => {
    const other = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "user_123", sid: "session_456" })
      .setProtectedHeader({ alg: "RS256", kid: "not-in-the-jwks" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(other.privateKey);
    const auth = createWorkosAuth(workos.config());
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });

  // Guards against a token minted by some other WorkOS tenant/environment that
  // happens to be signature-valid against a JWKS we trust.
  it("rejects a token from an unexpected issuer", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({
      sub: "user_123",
      sid: "session_456",
      issuer: "https://evil.example.com/",
    });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });

  // The bug this discovery path exists to fix: `iss` is scoped to the
  // environment's client id, so the old `${apiUrl}/` guess rejected every real
  // token. Pinning that guess must still be rejected.
  it("rejects a token when a wrong issuer is pinned", async () => {
    const auth = createWorkosAuth(workos.config({ workosIssuer: `${workos.origin}/` }));
    const token = await workos.signAccessToken({ sub: "user_123", sid: "session_456" });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });

  it("accepts a token whose issuer matches an explicit override", async () => {
    const auth = createWorkosAuth(workos.config({ workosIssuer: "https://auth.example.com" }));
    const token = await workos.signAccessToken({
      sub: "user_123",
      sid: "session_456",
      issuer: "https://auth.example.com",
    });
    await expect(auth.verifyAccessToken(token)).resolves.toMatchObject({ userId: "user_123" });
  });

  it("rejects a malformed token", async () => {
    const auth = createWorkosAuth(workos.config());
    await expect(auth.verifyAccessToken("not-a-jwt")).rejects.toThrow();
  });

  // Without `sid` there is no session identity to hang logout or session
  // listing on, so an otherwise well-signed token is still not usable.
  it("rejects a token missing the session id", async () => {
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({ sub: "user_123" });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow();
  });
});

describe("issuer discovery", () => {
  it("verifies against the environment-scoped issuer the metadata advertises", async () => {
    // Load-bearing: the fake mints `iss` under an environment client id that
    // is not the app's, so only a discovered issuer can match.
    expect(workos.issuer.endsWith(`/${workos.clientId}`)).toBe(false);
    const auth = createWorkosAuth(workos.config());
    const token = await workos.signAccessToken({ sub: "user_disco", sid: "session_disco" });
    await expect(auth.verifyAccessToken(token)).resolves.toEqual({
      userId: "user_disco",
      sessionId: "session_disco",
    });
  });

  it("fetches the metadata document exactly once across concurrent verifications", async () => {
    const auth = createWorkosAuth(workos.config());
    const before = workos.requests.length;
    const tokens = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => workos.signAccessToken({ sub: `user_${n}`, sid: `session_${n}` })),
    );

    await Promise.all(tokens.map((token) => auth.verifyAccessToken(token)));

    const discoveries = workos.requests
      .slice(before)
      .filter((request) => request.path === discoveryPath(workos.clientId));
    expect(discoveries).toHaveLength(1);
  });

  it("throws naming the discovery URL when the metadata cannot be loaded", async () => {
    // An unroutable origin: without a trusted issuer there is nothing safe to
    // fall back to, so verification must fail loudly rather than relax.
    const auth = createWorkosAuth(workos.config({ workosApiUrl: "http://127.0.0.1:1" }));
    const token = await workos.signAccessToken({ sub: "user_123", sid: "session_456" });
    await expect(auth.verifyAccessToken(token)).rejects.toThrow(
      `http://127.0.0.1:1/user_management/${workos.clientId}/.well-known/openid-configuration`,
    );
  });

  // A stalled connection would otherwise wedge every verification behind a
  // memoized promise that never settles — eviction only runs on rejection.
  // Asserting the signal rather than simulating a real hang, which is
  // expensive to stage and slow to run.
  it("bounds the discovery fetch with an abort signal", async () => {
    const realFetch = globalThis.fetch;
    const signals: Array<AbortSignal | null | undefined> = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((
      ...args: Parameters<typeof fetch>
    ) => {
      const [input, init] = args;
      if (String(input).includes(".well-known/openid-configuration")) {
        signals.push(init?.signal);
      }
      return realFetch(...args);
    }) as typeof fetch);

    try {
      const auth = createWorkosAuth(workos.config());
      const token = await workos.signAccessToken({ sub: "user_abort", sid: "session_abort" });
      await expect(auth.verifyAccessToken(token)).resolves.toMatchObject({ userId: "user_abort" });
    } finally {
      spy.mockRestore();
    }

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("skips discovery entirely when both the issuer and JWKS url are pinned", async () => {
    const auth = createWorkosAuth(
      workos.config({
        workosIssuer: workos.issuer,
        workosJwksUrl: `${workos.origin}/sso/jwks/${workos.clientId}`,
      }),
    );
    const before = workos.requests.length;
    const token = await workos.signAccessToken({ sub: "user_pinned", sid: "session_pinned" });

    await expect(auth.verifyAccessToken(token)).resolves.toMatchObject({ userId: "user_pinned" });
    expect(
      workos.requests.slice(before).filter((r) => r.path === discoveryPath(workos.clientId)),
    ).toHaveLength(0);
  });
});

describe("requestDeviceAuthorization", () => {
  it("posts the client id with the API key and maps the response to camelCase", async () => {
    const auth = createWorkosAuth(workos.config());
    const before = workos.requests.length;

    await expect(auth.requestDeviceAuthorization()).resolves.toEqual({
      deviceCode: "dc_fake_123",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.example.com/device",
      verificationUriComplete: "https://auth.example.com/device?user_code=ABCD-EFGH",
      expiresIn: 600,
      interval: 5,
    });

    const call = workos.requests[before];
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe("/user_management/authorize/device");
    expect(call?.authorization).toBe(`Bearer ${workos.apiKey}`);
    expect(call?.body).toContain(workos.clientId);
  });
});

describe("getUser", () => {
  it("sends the API key and maps the WorkOS user to our shape", async () => {
    const user = workos.addUser({
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      profile_picture_url: "https://cdn.example.com/ada.png",
    });
    const auth = createWorkosAuth(workos.config());
    const before = workos.requests.length;

    await expect(auth.getUser(user.id)).resolves.toEqual({
      id: user.id,
      email: "ada@example.com",
      name: "Ada Lovelace",
      avatarUrl: "https://cdn.example.com/ada.png",
    });
    expect(workos.requests[before]?.authorization).toBe(`Bearer ${workos.apiKey}`);
  });

  it("omits name and avatar when WorkOS has neither", async () => {
    const user = workos.addUser({ email: "nameless@example.com" });
    const auth = createWorkosAuth(workos.config());
    await expect(auth.getUser(user.id)).resolves.toEqual({
      id: user.id,
      email: "nameless@example.com",
    });
  });

  it("builds a name from whichever name parts exist", async () => {
    const user = workos.addUser({ email: "grace@example.com", first_name: "Grace" });
    const auth = createWorkosAuth(workos.config());
    await expect(auth.getUser(user.id)).resolves.toMatchObject({ name: "Grace" });
  });

  it("throws when WorkOS returns an error status", async () => {
    const auth = createWorkosAuth(workos.config());
    await expect(auth.getUser("user_does_not_exist")).rejects.toThrow();
  });
});
