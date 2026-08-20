import { describe, expect, it } from "vitest";

import { parseClaudeAuthStatusFromOutput } from "./claudeAuthStatus";

describe("Claude auth status malformed JSON", () => {
  it("does not treat malformed JSON with exit code zero as authenticated", () => {
    const result = parseClaudeAuthStatusFromOutput({
      stdout: '{"loggedIn":',
      stderr: "",
      code: 0,
    });

    expect(result.status).toBe("warning");
    expect(result.authStatus).toBe("unknown");
    expect(result.message).toContain("missing auth marker");
  });

  it("keeps plain successful non-JSON output on the legacy authenticated fallback", () => {
    const result = parseClaudeAuthStatusFromOutput({
      stdout: "Authenticated",
      stderr: "",
      code: 0,
    });

    expect(result).toEqual({ status: "ready", authStatus: "authenticated" });
  });
});
