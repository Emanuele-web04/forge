import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeWorkos, type FakeWorkos } from "./testing/fakeWorkos";
import { createWorkosAuth } from "./workos";

let workos: FakeWorkos;

beforeAll(async () => {
  workos = await startFakeWorkos();
});

afterAll(async () => {
  await workos.close();
});

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
