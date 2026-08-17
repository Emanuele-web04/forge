import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { registerProviderCredentialKey } from "../providerChildEnvironment.ts";
import { sanitizeUnmappedProviderData } from "./unmappedProviderEvents.ts";

describe("unmapped provider environment credential redaction", () => {
  it("redacts prefixed secret environment assignments in diagnostic text", () => {
    const sanitized = sanitizeUnmappedProviderData(
      "env OPENAI_API_KEY=sk-secret GITHUB_TOKEN='github-secret' NODE_ENV=development",
    );
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("github-secret");
    expect(serialized).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(serialized).toContain("GITHUB_TOKEN=[REDACTED]");
    expect(serialized).toContain("NODE_ENV=development");
  });

  it("redacts prefixed private keys", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData("env(FIREBASE_PRIVATE_KEY=private-key-material)"),
    );

    expect(serialized).not.toContain("private-key-material");
    expect(serialized).toContain("FIREBASE_PRIVATE_KEY=[REDACTED]");
  });

  it("redacts prefixed secret-key assignments and serialized maps", () => {
    const assignment = JSON.stringify(
      sanitizeUnmappedProviderData(
        "STRIPE_SECRET_KEY=assignment-secret SERVICE_APIKEY=compact-secret AWS_ACCESS_KEY_ID=assignment-access-id",
      ),
    );
    const serializedMap = JSON.stringify(
      sanitizeUnmappedProviderData(
        '{"STRIPE_SECRET_KEY":"map-secret","AWS_ACCESS_KEY_ID":"map-access-id"}',
      ),
    );

    expect(assignment).not.toContain("assignment-secret");
    expect(assignment).not.toContain("compact-secret");
    expect(serializedMap).not.toContain("map-secret");
    expect(assignment).not.toContain("assignment-access-id");
    expect(serializedMap).not.toContain("map-access-id");
    expect(assignment).toContain("STRIPE_SECRET_KEY=[REDACTED]");
    expect(assignment).toContain("SERVICE_APIKEY=[REDACTED]");
    expect(serializedMap).toContain('\\"STRIPE_SECRET_KEY\\":[REDACTED]');
    expect(assignment).toContain("AWS_ACCESS_KEY_ID=[REDACTED]");
    expect(serializedMap).toContain('\\"AWS_ACCESS_KEY_ID\\":[REDACTED]');
  });

  it("consumes escaped quotes inside quoted credential values", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData('DB_PASSWORD="abc\\"remaining-secret"'),
    );

    expect(serialized).not.toContain("remaining-secret");
    expect(serialized).toContain("DB_PASSWORD=[REDACTED]");
  });

  it("redacts prefixed credentials in serialized environment maps", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData('{"OPENAI_API_KEY":"sk-secret"}'),
    );

    expect(serialized).not.toContain("sk-secret");
    expect(serialized).toContain('\\"OPENAI_API_KEY\\":[REDACTED]');
  });

  it("redacts multiline quoted credential values through the closing quote", () => {
    const prefixed = JSON.stringify(
      sanitizeUnmappedProviderData(
        'FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nremaining-secret\n-----END PRIVATE KEY-----"',
      ),
    );
    const bare = JSON.stringify(
      sanitizeUnmappedProviderData(
        'private_key="-----BEGIN PRIVATE KEY-----\nbare-secret\n-----END PRIVATE KEY-----"',
      ),
    );
    const unquoted = JSON.stringify(
      sanitizeUnmappedProviderData(
        "FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nremaining-unquoted-secret\n-----END PRIVATE KEY----- NODE_ENV=development",
      ),
    );

    expect(prefixed).not.toContain("BEGIN PRIVATE KEY");
    expect(prefixed).not.toContain("remaining-secret");
    expect(prefixed).toContain("FIREBASE_PRIVATE_KEY=[REDACTED]");
    expect(bare).not.toContain("BEGIN PRIVATE KEY");
    expect(bare).not.toContain("bare-secret");
    expect(bare).toContain("private_key=[REDACTED]");
    expect(unquoted).not.toContain("BEGIN PRIVATE KEY");
    expect(unquoted).not.toContain("remaining-unquoted-secret");
    expect(unquoted).toContain("FIREBASE_PRIVATE_KEY=[REDACTED]");
    expect(unquoted).toContain("NODE_ENV=development");
  });

  it("fails closed on unterminated quoted credential values", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData('FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nsecret'),
    );

    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("secret");
    expect(serialized).toContain("FIREBASE_PRIVATE_KEY=[REDACTED]");
  });

  it("consumes Bearer-prefixed unquoted environment values", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData("OPENAI_API_KEY=Bearer sk-secret"),
    );

    expect(serialized).not.toContain("sk-secret");
    expect(serialized).toContain("OPENAI_API_KEY=[REDACTED]");
  });

  it("consumes ANSI-C-quoted multiline environment values", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData(
        "FIREBASE_PRIVATE_KEY=$'-----BEGIN PRIVATE KEY-----\\nremaining-secret\\n-----END PRIVATE KEY-----'",
      ),
    );

    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("remaining-secret");
    expect(serialized).toContain("FIREBASE_PRIVATE_KEY=[REDACTED]");
  });

  it("redacts credentials embedded in connection URLs", () => {
    const database = JSON.stringify(
      sanitizeUnmappedProviderData("DATABASE_URL=postgres://user:secret@host/db"),
    );
    const redis = JSON.stringify(
      sanitizeUnmappedProviderData("REDIS_URL=redis://:redis-secret@host/0"),
    );

    expect(database).not.toContain("user");
    expect(database).not.toContain("secret");
    expect(database).toContain("postgres://[REDACTED]@host/db");
    expect(redis).not.toContain("redis-secret");
    expect(redis).toContain("redis://[REDACTED]@host/0");
  });

  it("consumes escaped separators in unquoted shell values", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData(
        "SERVICE_APIKEY=abc\\ remaining-secret OTHER_TOKEN=def\\,remaining-token THIRD_SECRET=ghi\\;remaining-secret FOURTH_TOKEN='quoted-'continued-secret",
      ),
    );

    expect(serialized).not.toContain("remaining-secret");
    expect(serialized).not.toContain("remaining-token");
    expect(serialized).not.toContain("continued-secret");
    expect(serialized).toContain("SERVICE_APIKEY=[REDACTED]");
    expect(serialized).toContain("OTHER_TOKEN=[REDACTED]");
    expect(serialized).toContain("THIRD_SECRET=[REDACTED]");
    expect(serialized).toContain("FOURTH_TOKEN=[REDACTED]");
  });

  it("redacts credentials nested inside non-sensitive wrapper assignments", () => {
    const docker = JSON.stringify(
      sanitizeUnmappedProviderData("docker run --env=OPENAI_API_KEY=sk-leaked image"),
    );
    const quoted = JSON.stringify(
      sanitizeUnmappedProviderData('COMMAND="env GITHUB_TOKEN=gh-leaked app"'),
    );

    expect(docker).not.toContain("sk-leaked");
    expect(quoted).not.toContain("gh-leaked");
    expect(docker).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(quoted).toContain("GITHUB_TOKEN=[REDACTED]");
  });

  it("redacts decoded and raw name/value environment entries", () => {
    const decoded = JSON.stringify(
      sanitizeUnmappedProviderData([
        { name: "OPENAI_API_KEY", value: "decoded-secret" },
        { name: "AWS_ACCESS_KEY_ID", value: "decoded-access-id" },
        { name: "SAFE_ENV", value: "kept" },
      ]),
    );
    const raw = JSON.stringify(
      sanitizeUnmappedProviderData(
        'env: [{"name":"OPENAI_API_KEY","value":"raw-secret"},{"value":"reverse-secret","name":"GITHUB_TOKEN"},{"name":"STRIPE_SECRET_KEY","source":"process","value":"metadata-secret"},{"name":"OPENAI_API_KEY","metadata":{"source":"process"},"value":"nested-secret"},{"name":"SAFE_ENV","value":"kept"}]',
      ),
    );
    const inspected = JSON.stringify(
      sanitizeUnmappedProviderData("env: [{ name: 'OPENAI_API_KEY', value: 'inspected-secret' }]"),
    );
    const inspectedBacktick = JSON.stringify(
      sanitizeUnmappedProviderData(
        inspect({ name: "OPENAI_API_KEY", value: "inspected-'\" secret{with-braces}" }),
      ),
    );
    const inspectedNested = JSON.stringify(
      sanitizeUnmappedProviderData(
        inspect({
          value: "outer-safe",
          nested: { name: "OPENAI_API_KEY", value: "nested-inspected-secret" },
          sibling: { name: "GITHUB_TOKEN", value: "sibling-inspected-secret" },
        }),
      ),
    );

    expect(decoded).not.toContain("decoded-secret");
    expect(decoded).not.toContain("decoded-access-id");
    expect(raw).not.toContain("raw-secret");
    expect(raw).not.toContain("reverse-secret");
    expect(raw).not.toContain("metadata-secret");
    expect(raw).not.toContain("nested-secret");
    expect(inspected).not.toContain("inspected-secret");
    expect(inspectedBacktick).not.toContain("inspected-");
    expect(inspectedBacktick).not.toContain("with-braces");
    expect(inspectedNested).not.toContain("nested-inspected-secret");
    expect(inspectedNested).not.toContain("sibling-inspected-secret");
    expect(inspectedNested).toContain("outer-safe");
    expect(decoded).toContain('"value":"[REDACTED]"');
    expect(raw).toContain('\\"value\\":\\"[REDACTED]\\"');
    expect(decoded).toContain("kept");
    expect(raw).toContain("kept");
    expect(inspected).toContain("value: [REDACTED]");
    expect(inspectedBacktick).toContain("value: [REDACTED]");
  });

  it("redacts compact credential names in decoded environment maps", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData({
        AWS_ACCESS_KEY_ID: "decoded-map-access-id",
        SERVICE_APIKEY: "decoded-compact-key",
        PGPASSWORD: "decoded-compact-password",
      }),
    );

    expect(serialized).not.toContain("decoded-map-access-id");
    expect(serialized).not.toContain("decoded-compact-key");
    expect(serialized).not.toContain("decoded-compact-password");
    expect(serialized).toContain('"AWS_ACCESS_KEY_ID":"[REDACTED]"');
    expect(serialized).toContain('"SERVICE_APIKEY":"[REDACTED]"');
    expect(serialized).toContain('"PGPASSWORD":"[REDACTED]"');
  });

  it("preserves ordinary decoded payload keys ending in key", () => {
    const sanitized = sanitizeUnmappedProviderData({
      public_key: "public-material",
      request_key: "request-correlation",
      cacheKey: "cache-entry",
      env: {
        public_key: "nested-public-material",
        request_key: "nested-request-correlation",
        cacheKey: "nested-cache-entry",
        group: { SERVICE_APIKEY: "nested-credential-secret" },
      },
      named: { name: "public_key", value: "named-public-material" },
    });

    expect(sanitized).toEqual({
      public_key: "public-material",
      request_key: "request-correlation",
      cacheKey: "cache-entry",
      env: {
        public_key: "nested-public-material",
        request_key: "nested-request-correlation",
        cacheKey: "nested-cache-entry",
        group: { SERVICE_APIKEY: "[REDACTED]" },
      },
      named: { name: "public_key", value: "named-public-material" },
    });
  });

  it("redacts delimited custom provider credential keys", () => {
    const assignment = JSON.stringify(
      sanitizeUnmappedProviderData("MY_COMPANY_PROXY_KEY=assignment-proxy-secret"),
    );
    const decoded = JSON.stringify(
      sanitizeUnmappedProviderData({ MY_COMPANY_PROXY_KEY: "decoded-proxy-secret" }),
    );
    const named = JSON.stringify(
      sanitizeUnmappedProviderData({
        name: "MY_COMPANY_PROXY_KEY",
        value: "named-proxy-secret",
      }),
    );

    expect(assignment).not.toContain("assignment-proxy-secret");
    expect(decoded).not.toContain("decoded-proxy-secret");
    expect(named).not.toContain("named-proxy-secret");
    expect(assignment).toContain("MY_COMPANY_PROXY_KEY=[REDACTED]");
  });

  it("redacts exact configured provider credential keys in every supported shape", () => {
    registerProviderCredentialKey("ACME-LICENSE");
    const sanitized = JSON.stringify(
      sanitizeUnmappedProviderData({
        assignment: "ACME-LICENSE=assignment-secret",
        env: { "ACME-LICENSE": "decoded-secret" },
        tuple: ["ACME-LICENSE", "tuple-secret"],
        named: { name: "ACME-LICENSE", value: "named-secret" },
      }),
    );

    expect(sanitized).not.toContain("assignment-secret");
    expect(sanitized).not.toContain("decoded-secret");
    expect(sanitized).not.toContain("tuple-secret");
    expect(sanitized).not.toContain("named-secret");
  });

  it("redacts Docker auth configuration as one credential value", () => {
    const dockerAuth =
      '{"auths":{"one.example":{"auth":"dXNlcjpmaXJzdA=="},"two.example":{"auth":"dXNlcjpzZWNvbmQ=","identitytoken":"identity-secret"}}}';
    const assignment = JSON.stringify(
      sanitizeUnmappedProviderData(`DOCKER_AUTH_CONFIG=${dockerAuth}`),
    );
    const decoded = JSON.stringify(
      sanitizeUnmappedProviderData({ env: { DOCKER_AUTH_CONFIG: dockerAuth } }),
    );

    expect(assignment).not.toContain("dXNlcjpmaXJzdA");
    expect(assignment).not.toContain("dXNlcjpzZWNvbmQ");
    expect(assignment).not.toContain("identity-secret");
    expect(decoded).not.toContain("dXNlcjpmaXJzdA");
    expect(decoded).not.toContain("dXNlcjpzZWNvbmQ");
    expect(decoded).not.toContain("identity-secret");
    expect(assignment).toContain("DOCKER_AUTH_CONFIG=[REDACTED]");
    expect(decoded).toContain('"DOCKER_AUTH_CONFIG":"[REDACTED]"');
  });

  it("redacts environment tuples in text and decoded data", () => {
    const json = JSON.stringify(
      sanitizeUnmappedProviderData(
        'env: [["OPENAI_API_KEY","raw-tuple-secret"],["SAFE_ENV","kept"]]',
      ),
    );
    const inspected = JSON.stringify(
      sanitizeUnmappedProviderData("env: [ [ 'GITHUB_TOKEN', 'inspected-tuple-secret' ] ]"),
    );
    const decoded = JSON.stringify(
      sanitizeUnmappedProviderData([
        ["MY_COMPANY_PROXY_KEY", "decoded-tuple-secret"],
        ["SAFE_ENV", "kept"],
      ]),
    );

    expect(json).not.toContain("raw-tuple-secret");
    expect(inspected).not.toContain("inspected-tuple-secret");
    expect(decoded).not.toContain("decoded-tuple-secret");
    expect(json).toContain("kept");
    expect(decoded).toContain("kept");
  });

  it("redacts credentials inside nested serialized payload strings", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData('{"payload":"{\\"OPENAI_API_KEY\\":\\"nested-secret\\"}"}'),
    );

    expect(serialized).not.toContain("nested-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("preserves unrelated JSON number tokens during redaction", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData('{"OPENAI_API_KEY":"secret","requestId":9007199254740993}'),
    );

    expect(serialized).not.toContain("secret");
    expect(serialized).toContain("9007199254740993");
    expect(serialized).not.toContain("9007199254740992");
  });

  it("bounds URL scanning work for long diagnostics without URLs", () => {
    const sanitized = sanitizeUnmappedProviderData("a".repeat(50_000));

    expect(sanitized).toMatchObject({ __synaraTruncated: true });
  });

  it("fails closed without recursion on excessively nested inspected objects", () => {
    const sanitized = sanitizeUnmappedProviderData(
      `${"{".repeat(10_000)} name: 'OPENAI_API_KEY', value: 'deep-secret'`,
    );

    expect(sanitized).toBe("[REDACTED]");
  });

  it("keeps assignment redaction idempotent", () => {
    const once = sanitizeUnmappedProviderData("OPENAI_API_KEY=raw-secret");
    const twice = sanitizeUnmappedProviderData(once);

    expect(once).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(twice).toBe(once);
  });

  it("fails closed on truncated raw name/value entries", () => {
    const raw = JSON.stringify(
      sanitizeUnmappedProviderData('env: {"name":"OPENAI_API_KEY","value":"raw-secret'),
    );

    expect(raw).not.toContain("raw-secret");
    expect(raw).toContain('\\"value\\":[REDACTED]');
  });
});
