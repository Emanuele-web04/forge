import { describe, expect, it } from "vitest";

import {
  buildProvisioningIdentity,
  parseEnvironmentIdFile,
  ProvisioningIdentityError,
} from "./provisioningIdentity";
import { verifyProvisioningHandshake } from "./remoteBootstrap/provisioningHandshake";

describe("parseEnvironmentIdFile", () => {
  it("strips the trailing newline bootstrap writes", () => {
    expect(parseEnvironmentIdFile("env-abc\n", "/state/environment-id")).toBe("env-abc");
  });

  /**
   * Empty is an ERROR, not "no environment". A truncated write must produce a
   * clear failure rather than a puzzling handshake refusal downstream.
   */
  it("refuses an empty or whitespace-only file", () => {
    for (const contents of ["", "   ", "\n", "\t\n "]) {
      expect(() => parseEnvironmentIdFile(contents, "/state/environment-id")).toThrow(
        ProvisioningIdentityError,
      );
    }
  });

  it("refuses a multi-line file rather than guessing which line is the id", () => {
    expect(() => parseEnvironmentIdFile("env-a\nenv-b\n", "/state/environment-id")).toThrow(
      ProvisioningIdentityError,
    );
  });
});

describe("buildProvisioningIdentity", () => {
  const read = (contents: string) => () => contents;

  it("reports the provisioned environment id, the version, and the token it accepted", () => {
    const identity = buildProvisioningIdentity({
      environmentIdFile: "/state/environment-id",
      serverVersion: "1.2.3",
      presentedToken: "tok-1",
      readFile: read("env-abc\n"),
    });
    expect(identity).toEqual({
      environmentId: "env-abc",
      serverVersion: "1.2.3",
      acceptedToken: "tok-1",
      authenticated: true,
    });
  });

  /**
   * An unreadable id must leave the field ABSENT rather than empty or invented:
   * the broker's check is default-deny, so absence is a refusal there, whereas
   * an invented value could accidentally match.
   */
  it("leaves the environment id absent when the file cannot be read", () => {
    const identity = buildProvisioningIdentity({
      environmentIdFile: "/state/environment-id",
      serverVersion: "1.2.3",
      presentedToken: "tok-1",
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(identity.environmentId).toBeUndefined();
    // And the broker refuses on it, rather than attaching to an unknown server.
    const verdict = verifyProvisioningHandshake({
      claim: identity,
      expected: {
        environmentId: "env-abc",
        serverVersion: "1.2.3",
        credential: { token: "tok-1" },
      },
    });
    expect(verdict.ok).toBe(false);
  });

  it("is unauthenticated when no token was presented", () => {
    const identity = buildProvisioningIdentity({
      environmentIdFile: "/state/environment-id",
      serverVersion: "1.2.3",
      presentedToken: undefined,
      readFile: read("env-abc\n"),
    });
    expect(identity.authenticated).toBe(false);
    expect(identity.acceptedToken).toBeUndefined();
  });

  /**
   * The end-to-end shape: what this server answers is exactly what the broker's
   * verdict accepts. These two halves live in different packages and are the
   * pair most likely to drift apart silently.
   */
  it("produces a claim the broker accepts when everything matches", () => {
    const identity = buildProvisioningIdentity({
      environmentIdFile: "/state/environment-id",
      serverVersion: "1.2.3",
      presentedToken: "tok-1",
      readFile: read("env-abc\n"),
    });
    expect(
      verifyProvisioningHandshake({
        claim: identity,
        expected: {
          environmentId: "env-abc",
          serverVersion: "1.2.3",
          credential: { token: "tok-1" },
        },
      }),
    ).toEqual({ ok: true });
  });

  it("is refused when the server runs a different release than we activated", () => {
    const identity = buildProvisioningIdentity({
      environmentIdFile: "/state/environment-id",
      serverVersion: "1.2.2",
      presentedToken: "tok-1",
      readFile: read("env-abc\n"),
    });
    const verdict = verifyProvisioningHandshake({
      claim: identity,
      expected: {
        environmentId: "env-abc",
        serverVersion: "1.2.3",
        credential: { token: "tok-1" },
      },
    });
    expect(verdict.ok).toBe(false);
  });
});
