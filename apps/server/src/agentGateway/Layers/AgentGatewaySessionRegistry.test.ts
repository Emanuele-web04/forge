import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@synara/contracts";

import { makeAgentGatewaySessionRegistry } from "./AgentGatewaySessionRegistry.ts";

describe("AgentGatewaySessionRegistry", () => {
  it("allows independent legitimate sessions for the same thread", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const first = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const second = registry.issue(ThreadId.makeUnsafe("thread-1"), "claudeAgent");
    assert.notEqual(first.token, second.token);
    assert.equal(registry.verify(first.token)?.threadId, "thread-1");
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");
    assert.equal(registry.verify(first.token)?.provider, "codex");
    assert.equal(registry.verify(second.token)?.provider, "claudeAgent");
  });

  it("keeps replacement runtime credentials independent from outgoing-session revocation", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const first = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const second = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    assert.notEqual(first.token, second.token);
    assert.equal(registry.verify(first.token)?.threadId, "thread-1");
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");

    registry.revoke(first.token);
    assert.isNull(registry.verify(first.token));
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");
  });

  it("binds write authority to one exact turn and invalidates it on revocation", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "authority" });
    const issued = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const authority = registry.bindWriteAuthority(issued.token, "turn-a");

    assert.isNotNull(authority);
    assert.equal(authority?.turnId, "turn-a");
    assert.isTrue(registry.verifyWriteAuthority(authority!));

    registry.revoke(issued.token);
    assert.isFalse(registry.verifyWriteAuthority(authority!));
    assert.isNull(registry.bindWriteAuthority(issued.token, "turn-b"));
  });

  it("permanently fences a terminal turn credential even when A never used it", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const outgoing = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");

    assert.isTrue(registry.retireWriteAuthority(outgoing.token, "turn-a"));
    assert.isNull(registry.bindWriteAuthority(outgoing.token, "turn-a"));
    assert.isNull(registry.bindWriteAuthority(outgoing.token, "turn-b"));
    // Retirement is idempotent for the same terminal turn but cannot be
    // reassigned to a different one.
    assert.isTrue(registry.retireWriteAuthority(outgoing.token, "turn-a"));
    assert.isFalse(registry.retireWriteAuthority(outgoing.token, "turn-b"));

    const replacement = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const turnBAuthority = registry.bindWriteAuthority(replacement.token, "turn-b");
    assert.isNotNull(turnBAuthority);
    assert.isTrue(registry.verifyWriteAuthority(turnBAuthority!));
  });

  it("keeps credentials valid for a long-lived provider session but not across restart", () => {
    let time = 1_000;
    const firstRegistry = makeAgentGatewaySessionRegistry({
      now: () => time,
      randomId: () => "first",
    });
    const issued = firstRegistry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    time += 48 * 60 * 60 * 1_000;
    assert.equal(firstRegistry.verify(issued.token)?.threadId, "thread-1");

    const afterRestart = makeAgentGatewaySessionRegistry({ randomId: () => "second" });
    assert.isNull(afterRestart.verify(issued.token));
  });

  it("keeps raw bearer tokens out of verified session identity snapshots", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "opaque-secret" });
    const issued = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const verified = registry.verify(issued.token);
    assert.match(issued.token, /^sagw_session_/);
    assert.notProperty(verified, "token");
    assert.notInclude(JSON.stringify(verified), issued.token);
  });

  it("keeps computer control opt-in instead of adding it to provider defaults", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "computer" });
    const ordinary = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const optedIn = registry.issue(ThreadId.makeUnsafe("thread-2"), "codex", {
      additionalCapabilities: ["computer:control"],
    });

    assert.isFalse(ordinary.capabilities.has("computer:control"));
    assert.isTrue(optedIn.capabilities.has("computer:control"));
  });
});
