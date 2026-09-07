import { app, safeStorage, session } from "electron";
import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createCookieSessionBackend } from "../src/browserAutomation/electronCookieSession";
import { BrowserSessionRestore } from "../src/browserAutomation/browserSessionRestore";

void (async () => {
const home = await mkdtemp(join(tmpdir(), "synara-session-native-"));
app.setPath("userData", home);
await app.whenReady();
let stage = "create";
try {
  const backend = createCookieSessionBackend("persist:session-smoke");
  stage = "set";
  await session.fromPartition("persist:session-smoke").cookies.set({ url: "https://example.test/", name: "from-native-partition", value: "synthetic-only" });
  await backend.restore([{ name: "synthetic", value: "synthetic-only", url: "https://example.test/", secure: true, httpOnly: true }]);
  await backend.restore(["https://first.test", "https://second.test"].map((topLevelSite) => ({
    name: "partitioned", value: "synthetic-only", url: "https://example.test/", secure: true, httpOnly: true, sameSite: "None",
    partitionKey: { topLevelSite, hasCrossSiteAncestor: true },
  })));
  assert.equal((await session.fromPartition("persist:session-smoke").cookies.get({ name: "synthetic" })).length, 1);
  assert.equal((await session.defaultSession.cookies.get({ name: "synthetic" })).length, 0);
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  stage = "read";
  const cookies = await backend.read();
  assert.equal(cookies.length, 4);
  const received = cookies as Array<{ name: string; partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean } }>;
  const partitioned = received.filter((cookie) => cookie.name === "partitioned");
  assert.deepEqual(partitioned.map((cookie) => cookie.partitionKey?.topLevelSite).sort(), ["https://first.test", "https://second.test"]);
  assert.ok(partitioned.every((cookie) => cookie.partitionKey?.hasCrossSiteAncestor));
  console.log(JSON.stringify({ count: cookies.length, fields: Object.keys(cookies[0] ?? {}) }));
  stage = "initialize";
  const restore = new BrowserSessionRestore(join(home, "restore"), backend, {
    available: async () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value),
  });
  await restore.initialize();
  stage = "remember";
  await restore.rememberImport(["example.test"]);
  stage = "shutdown";
  await restore.shutdown();
  console.log("Session restoration native smoke passed");
  app.exit(0);
} catch (error) {
  console.log(JSON.stringify({ failed: stage, message: error instanceof Error ? error.message : "unknown" }));
  app.exit(1);
}
})();
