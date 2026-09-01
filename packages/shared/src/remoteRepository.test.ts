import { describe, expect, it } from "vitest";

import { parseRemoteRepositoryUrl, remoteRepositoryIdentityKey } from "./remoteRepository";

describe("parseRemoteRepositoryUrl", () => {
  it.each([
    [
      "git@bitbucket.org:paraty/payment-seeker.git",
      {
        provider: "bitbucket",
        host: "bitbucket.org",
        owner: "paraty",
        slug: "payment-seeker",
        webUrl: "https://bitbucket.org/paraty/payment-seeker",
        identityKey: "bitbucket:bitbucket.org:paraty/payment-seeker",
        displayName: "paraty/payment-seeker",
      },
    ],
    [
      " HTTPS://BITBUCKET.ORG/PARATY/Payment-Seeker.git/ ",
      {
        provider: "bitbucket",
        host: "bitbucket.org",
        owner: "PARATY",
        slug: "Payment-Seeker",
        webUrl: "https://bitbucket.org/PARATY/Payment-Seeker",
        identityKey: "bitbucket:bitbucket.org:paraty/payment-seeker",
        displayName: "PARATY/Payment-Seeker",
      },
    ],
    [
      "git@github.com:openai/codex.git",
      {
        provider: "github",
        host: "github.com",
        owner: "openai",
        slug: "codex",
        webUrl: "https://github.com/openai/codex",
        identityKey: "github:github.com:openai/codex",
        displayName: "openai/codex",
      },
    ],
    [
      "ssh://git@github.com/OpenAI/Codex.git",
      {
        provider: "github",
        host: "github.com",
        owner: "OpenAI",
        slug: "Codex",
        webUrl: "https://github.com/OpenAI/Codex",
        identityKey: "github:github.com:openai/codex",
        displayName: "OpenAI/Codex",
      },
    ],
    [
      "https://github.com/openai/codex",
      {
        provider: "github",
        host: "github.com",
        owner: "openai",
        slug: "codex",
        webUrl: "https://github.com/openai/codex",
        identityKey: "github:github.com:openai/codex",
        displayName: "openai/codex",
      },
    ],
    [
      "git://github.com/openai/codex/",
      {
        provider: "github",
        host: "github.com",
        owner: "openai",
        slug: "codex",
        webUrl: "https://github.com/openai/codex",
        identityKey: "github:github.com:openai/codex",
        displayName: "openai/codex",
      },
    ],
  ] as const)("parses supported remote %s", (remote, expected) => {
    expect(parseRemoteRepositoryUrl(remote)).toEqual(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "https://bitbucket.org:443/paraty/payment-seeker.git",
    "ssh://git@github.com:22/openai/codex.git",
    "https://github.com/openai/codex.git#readme",
    "https://bitbucket.org.evil/paraty/payment-seeker.git",
    "git@github.com.evil:openai/codex.git",
    "https://gitlab.com/paraty/payment-seeker.git",
    "https://bitbucket.org/other/payment-seeker.git",
    "git@bitbucket.org:other/payment-seeker.git",
    "ssh://git@bitbucket.org/paraty/payment-seeker.git",
    "git://bitbucket.org/paraty/payment-seeker.git",
    "https://bitbucket.org/paraty/",
    "https://bitbucket.org//payment-seeker",
    "https://bitbucket.org/paraty/.",
    "https://bitbucket.org/paraty/..",
    "https://bitbucket.org/paraty/%2e%2e",
    "https://bitbucket.org/paraty/%2Fetc",
    "https://github.com/./codex",
    "https://github.com/openai/%2e%2e",
    "https://github.com/openai/codex/issues",
    "git@github.com:openai/codex.git/extra",
  ])("rejects unsupported or unsafe remote %s", (remote) => {
    expect(parseRemoteRepositoryUrl(remote)).toBeNull();
  });

  it.each([
    {
      label: "Bitbucket HTTPS userinfo",
      remote: "https://user:token@bitbucket.org/paraty/payment-seeker.git",
    },
    {
      label: "GitHub HTTPS userinfo",
      remote: "https://user:token@github.com/openai/codex.git",
    },
    {
      label: "sensitive query data",
      remote: "https://bitbucket.org/paraty/payment-seeker.git?token=secret",
    },
  ])("rejects $label", ({ remote }) => {
    expect(parseRemoteRepositoryUrl(remote)).toBeNull();
  });

  it.each([
    {
      label: "GitHub Cyrillic-i homograph host",
      remote: "https://gіthub.com/openai/codex.git",
    },
    {
      label: "Bitbucket Cyrillic-i homograph host",
      remote: "https://bіtbucket.org/paraty/payment-seeker.git",
    },
    {
      label: "GitHub fullwidth-dot separator",
      remote: "https://github．com/openai/codex.git",
    },
    {
      label: "Bitbucket ideographic-dot separator",
      remote: "https://bitbucket。org/paraty/payment-seeker.git",
    },
    {
      label: "GitHub fullwidth-slash separator",
      remote: "https://github.com／openai/codex.git",
    },
    {
      label: "Bitbucket division-slash separator",
      remote: "https://bitbucket.org/paraty∕payment-seeker.git",
    },
    {
      label: "GitHub IDNA homograph host",
      remote: "https://xn--gthub-n2e.com/openai/codex.git",
    },
    {
      label: "Bitbucket IDNA homograph host",
      remote: "https://xn--btbucket-thh.org/paraty/payment-seeker.git",
    },
    {
      label: "GitHub punycode suffix host",
      remote: "https://github.xn--com-9o0a/openai/codex.git",
    },
    {
      label: "Bitbucket punycode suffix host",
      remote: "https://bitbucket.xn--org-9o0a/paraty/payment-seeker.git",
    },
  ])("rejects $label", ({ remote }) => {
    expect(parseRemoteRepositoryUrl(remote)).toBeNull();
  });
});

describe("remoteRepositoryIdentityKey", () => {
  it("normalizes provider repository casing", () => {
    expect(
      remoteRepositoryIdentityKey({
        provider: "bitbucket",
        host: "BITBUCKET.ORG",
        owner: "PARATY",
        slug: "Payment-Seeker",
      }),
    ).toBe("bitbucket:bitbucket.org:paraty/payment-seeker");
  });
});
