import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const requireFromWebWorkspace = createRequire(new URL("../apps/web/package.json", import.meta.url));
const cliPath = requireFromWebWorkspace.resolve("@effect/language-service/cli.js");

execFileSync(process.execPath, [cliPath, "patch"], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit",
});
