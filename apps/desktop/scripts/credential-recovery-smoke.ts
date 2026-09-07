import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBetterwright } from "../src/browserAutomation/betterwrightRuntime";
import { BrowserVault } from "../src/browserAutomation/browserVault";
import { BrowserAutomationHostError } from "../src/browserAutomation/hostErrors";

// A signup with no autocomplete/new-password hints, matching the failing form shape.
const html = `<!doctype html><title>Credential recovery fixture</title>
<form onsubmit="event.preventDefault();document.querySelector('output').textContent='Accepted'">
<h1>Create your free account</h1>
<label>Name<input name="name"></label><label>Organization<input name="organization"></label>
<label>Email<input name="email" type="email" aria-label="Email"></label>
<label>Password<input name="password" type="password" placeholder="Password (8+ characters)" aria-label="Password"></label>
<button>Get set up</button></form><output>Waiting</output>`;

async function smoke() {
  const home = await mkdtemp(join(tmpdir(), "synara-credential-recovery-"));
  app.setPath("userData", join(home, "electron"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const vault = new BrowserVault(join(home, "saved-logins"));
  try {
    await vault.setupMaster("SyntheticRecoveryFixtureOnly42!");
    await window.loadURL(`http://127.0.0.1:${address.port}/signup`);
    const signal = new AbortController().signal;
    const options = { home: join(home, "worker"), contents: window.webContents, timeoutMs: 30000,
      signal, vault: vault.agentAdapter(window.webContents, signal) };
    const inspection = await runBetterwright<{ status: string }>({ ...options, code: "return credentials.inspect({generate:true})" });
    if (inspection.status !== "not-found") throw new Error("Fixture did not reproduce missing signup semantics");
    const failure = await runBetterwright({ ...options, code: "return credentials.generateAndFill({username:'fixture@example.test'})" }).then(() => null, (error: unknown) => error);
    if (!(failure instanceof BrowserAutomationHostError) || failure.browserError.code !== "BrowserCredentialTargetRequired") {
      throw new Error("Credential failure did not provide safe recovery guidance");
    }
    if ((await vault.snapshot()).logins.length !== 0) throw new Error("Failed detection generated a credential");
    const generated = await runBetterwright<{ pendingId: string; filled: string[] }>({ ...options,
      code: "return credentials.generateAndFill({username:'fixture@example.test',usernameSelector:'input[name=email]',passwordSelector:'input[name=password]'})",
    });
    if (!generated.pendingId || !generated.filled.includes("password") || !generated.filled.includes("username")) {
      throw new Error("Explicit credential recovery did not fill both fields");
    }
    const filled = await window.webContents.executeJavaScript("document.querySelector('input[type=password]').value.length >= 12 && document.querySelector('input[type=email]').value === 'fixture@example.test'");
    if (!filled) throw new Error("Native form values were not filled");
    const pending = await vault.snapshot();
    if (pending.logins.length !== 1 || pending.logins[0]?.status !== "pending") throw new Error("Generated credential is not recoverable");
    const outcome = await runBetterwright<string>({ ...options,
      code: "await page.getByRole('button',{name:'Get set up'}).click(); return page.locator('output').textContent()",
    });
    if (outcome !== "Accepted") throw new Error("Synthetic submission was not confirmed");
    await runBetterwright({ ...options, code: `return credentials.commitGenerated({pendingId:${JSON.stringify(generated.pendingId)}})` });
    if ((await vault.snapshot()).logins[0]?.status !== "saved") throw new Error("Generated credential did not commit");
    console.log(JSON.stringify({ missingSemantics: "reproduced", safeError: "passed", explicitSelectors: "filled", syntheticSubmission: "accepted", commitAfterWorkerRestart: "passed" }));
  } finally {
    vault.dispose();
    window.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

void app.whenReady().then(smoke).then(() => app.exit(0), () => {
  console.error("Credential recovery smoke failed; no credential values were logged.");
  app.exit(1);
});
