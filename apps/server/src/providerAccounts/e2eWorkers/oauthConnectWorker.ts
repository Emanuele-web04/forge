import { Effect } from "effect";

import { makeAccountConnect } from "../accountConnect";
import { makeAccountStorage } from "../accountStorage";
import type { OAuthLoginRunner } from "../oauthLogin";

const root = process.argv[2];
if (root === undefined) {
  process.stderr.write("Usage: oauthConnectWorker.ts <account-root>\n");
  process.exit(2);
}

// A login that surfaces a verification prompt and then hangs forever, exactly
// like a user who never finishes the browser flow.
const neverendingOauthRunner: OAuthLoginRunner = (request) => {
  request.onVerification({
    verificationUrl: "https://example.com/device",
    userCode: "KILL-ME",
  });
  return { done: new Promise(() => {}), cancel: () => {} };
};

const storage = makeAccountStorage({ root });
const connect = makeAccountConnect({
  storage,
  oauthLoginRunners: { codex: neverendingOauthRunner },
});

await Effect.runPromise(storage.ensureRoot);
const { operationId } = await Effect.runPromise(
  connect.beginConnect({ kind: "agent-oauth", provider: "codex" }),
);
process.stdout.write(`${JSON.stringify({ operationId })}\n`);

// Stay alive until the test kills this process.
setInterval(() => {}, 60_000);
