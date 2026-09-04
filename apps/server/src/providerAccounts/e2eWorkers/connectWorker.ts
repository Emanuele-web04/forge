import { Effect } from "effect";

import { makeAccountConnect } from "../accountConnect";
import { makeAccountStorage } from "../accountStorage";

const [root, ...apiKeys] = process.argv.slice(2);
if (root === undefined || apiKeys.length === 0) {
  process.stderr.write("Usage: connectWorker.ts <account-root> <api-key...>\n");
  process.exit(2);
}

const storage = makeAccountStorage({ root });
const connect = makeAccountConnect({ storage });

const results = await Promise.all(
  apiKeys.map(async (apiKey) => {
    const { operationId } = await Effect.runPromise(
      connect.beginConnect({ kind: "agent-api-key", provider: "codex", apiKey }),
    );
    const status = await Effect.runPromise(connect.getConnectStatus(operationId));
    return { apiKey, state: status.state, ordinal: status.ordinal ?? null };
  }),
);

process.stdout.write(JSON.stringify(results));
