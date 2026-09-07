// FILE: run.ts
// Purpose: Orchestrates a local end-to-end run of the remote-host stack across
// a real network boundary. The account API, relay, and Postgres run as their
// production Docker images. A real Synara host (apps/server, from source)
// runs on THIS machine, enrolls headlessly through the device-code flow, and
// dials the relay. Then an isolated container — a packet filter lets it reach
// only the API and relay ports, not the host's port on the same IP, not other
// containers, not the internet — reaches the host through the relay with the
// production protocol. apps/e2e/docker/client.ts is what runs in there.
//
// Run from the repository root:  bun apps/e2e/docker/run.ts
// SYNARA_E2E_KEEP=1 leaves containers and the host running for inspection.
// SYNARA_E2E_STACK_ONLY=1 brings up Postgres, the API and the relay and stops
// there, leaving them running — for driving the stack by hand, e.g. two
// desktop apps connecting to each other over the relay.
// Layer: E2E tooling (orchestrator, runs on the developer machine)

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAccountClient, OrganizationRequiredError } from "@synara/shared/account";

const REPO = path.resolve(import.meta.dirname, "../../..");
const SCRATCH = "/tmp/synara-e2e";
const LOGS = path.join(SCRATCH, "logs");
const HOME = path.join(SCRATCH, "home");
const PROJECT = path.join(SCRATCH, "project");

const API_PORT = 8788;
const RELAY_PORT = 8789;
const HOST_PORT = 3899;
const OWNER_EMAIL = "owner@e2e.local";

const NET_SERVICES = "synara-e2e-services"; // API + relay + Postgres
const NET_CLIENT = "synara-e2e-client"; // the isolated client, alone
const CONTAINERS = {
  db: "synara-e2e-db",
  api: "synara-e2e-api",
  relay: "synara-e2e-relay",
  client: "synara-e2e-client",
  control: "synara-e2e-control",
};

const stackOnly = process.env.SYNARA_E2E_STACK_ONLY === "1";
const keep = process.env.SYNARA_E2E_KEEP === "1" || stackOnly;
const relayServiceToken = randomBytes(24).toString("base64url");
const apiSigningKey = randomBytes(32).toString("base64url");
const hostAuthToken = randomBytes(24).toString("base64url");

// Every JWT in the system is bound to the API's public URL (issuer and
// audiences), so the host on this machine and the client in the container
// must both name it by ONE string that resolves for both. The machine's LAN
// IP is that string: Docker publishes the API and relay on it, this machine
// hairpins to it, and containers route to it.
const lanIp = detectLanIp();
const API_URL = `http://${lanIp}:${API_PORT}`;
const RELAY_URL = `http://${lanIp}:${RELAY_PORT}`;

type Row = { step: string; ok: boolean; ms?: number; detail: string };
const rows: Row[] = [];
let hostProcess: ChildProcess | undefined;

function detectLanIp(): string {
  const address = Object.values(os.networkInterfaces())
    .flat()
    .find(
      (iface) =>
        iface !== undefined &&
        iface.family === "IPv4" &&
        !iface.internal &&
        !iface.address.startsWith("169.254.") &&
        // CGNAT range: Tailscale and similar overlays, not the LAN.
        !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(iface.address),
    )?.address;
  if (!address) throw new Error("no non-loopback IPv4 interface found on this machine");
  return address;
}

function log(message: string): void {
  console.log(`\x1b[2m[run]\x1b[0m ${message}`);
}

function compact(detail: Record<string, unknown>): string {
  const text = JSON.stringify(detail);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function record(
  step: string,
  ok: boolean,
  detail: Record<string, unknown> = {},
  ms?: number,
): void {
  rows.push({ step, ok, ...(ms === undefined ? {} : { ms }), detail: compact(detail) });
  const mark = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${mark} ${step}${ms === undefined ? "" : ` \x1b[2m${ms}ms\x1b[0m`}`);
  if (!ok) console.log(`    ${compact(detail)}`);
}

async function sh(
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number>((resolve) =>
    child.on("close", (exitCode) => resolve(exitCode ?? 1)),
  );
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr || stdout}`);
  }
  return stdout.trim();
}

const docker = (...args: string[]) => sh("docker", args);
const dockerQuiet = (...args: string[]) => sh("docker", args, { allowFailure: true });

async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await probe().catch(() => false)) return Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function relayReportsHost(hostId: string): Promise<boolean> {
  const response = await fetch(`${RELAY_URL}/healthz/host/${hostId}`, {
    signal: AbortSignal.timeout(2_000),
  });
  return ((await response.json()) as { ready?: boolean }).ready === true;
}

async function tailLog(name: string, lines = 15): Promise<string> {
  const text = await fs.readFile(path.join(LOGS, name), "utf8").catch(() => "");
  return text.trim().split("\n").slice(-lines).join("\n");
}

async function removeEverything(): Promise<void> {
  for (const name of Object.values(CONTAINERS)) await dockerQuiet("rm", "-f", name);
  await dockerQuiet("network", "rm", NET_CLIENT);
  await dockerQuiet("network", "rm", NET_SERVICES);
}

async function teardown(): Promise<void> {
  if (keep) {
    log(
      `SYNARA_E2E_KEEP=1 — containers and host left running (host pid ${hostProcess?.pid}). Logs: ${LOGS}`,
    );
    return;
  }
  hostProcess?.kill("SIGTERM");
  await removeEverything();
}

async function captureContainerLogs(): Promise<void> {
  for (const [key, name] of Object.entries(CONTAINERS)) {
    const text = await dockerQuiet("logs", name);
    if (text) await fs.writeFile(path.join(LOGS, `${key}.log`), text).catch(() => undefined);
  }
}

// ── Infrastructure: production images on Docker ──────────────────────

async function startInfrastructure(): Promise<void> {
  await removeEverything();
  await fs.rm(HOME, { recursive: true, force: true });
  await fs.mkdir(LOGS, { recursive: true });
  await fs.mkdir(HOME, { recursive: true });
  await fs.mkdir(PROJECT, { recursive: true });
  // A real project is a git repo; the host's checkpoint/diff paths key on it.
  if (!(await fs.stat(path.join(PROJECT, ".git")).catch(() => undefined))) {
    await sh("git", ["-C", PROJECT, "init", "-q"]);
    await fs.writeFile(path.join(PROJECT, "README.md"), "# e2e scratch project\n");
    await sh("git", ["-C", PROJECT, "add", "README.md"]);
    await sh("git", [
      "-C",
      PROJECT,
      "-c",
      "user.name=e2e",
      "-c",
      "user.email=e2e@example.test",
      "commit",
      "-q",
      "-m",
      "init",
    ]);
  }

  await docker("network", "create", NET_SERVICES);
  await docker("network", "create", NET_CLIENT);

  await docker(
    "run",
    "-d",
    "--name",
    CONTAINERS.db,
    "--network",
    NET_SERVICES,
    "-e",
    "POSTGRES_USER=synara",
    "-e",
    "POSTGRES_PASSWORD=synara",
    "-e",
    "POSTGRES_DB=synara_accounts",
    "postgres:18",
  );
  const dbMs = await waitFor(
    "postgres",
    async () =>
      (
        await dockerQuiet(
          "exec",
          CONTAINERS.db,
          "pg_isready",
          "-U",
          "synara",
          "-d",
          "synara_accounts",
        )
      ).includes("accepting"),
    60_000,
  );
  record("postgres:18 ready", true, {}, dbMs);

  // The image bakes NODE_ENV=production; the dev identity provider refuses to
  // start under it (it prints sign-in codes to stdout), so override it here.
  await docker(
    "run",
    "-d",
    "--name",
    CONTAINERS.api,
    "--network",
    NET_SERVICES,
    "-p",
    `${API_PORT}:${API_PORT}`,
    "-e",
    "NODE_ENV=development",
    "-e",
    "IDENTITY_PROVIDER=dev",
    "-e",
    `DATABASE_URL=postgres://synara:synara@${CONTAINERS.db}:5432/synara_accounts`,
    "-e",
    `ACCOUNT_BASE_URL=${API_URL}`,
    "-e",
    `API_PUBLIC_URL=${API_URL}/api/v1`,
    "-e",
    `API_SIGNING_KEY=${apiSigningKey}`,
    "-e",
    `RELAY_SERVICE_TOKEN=${relayServiceToken}`,
    "-e",
    `PORT=${API_PORT}`,
    "synara-e2e/api:local",
  );
  const apiMs = await waitFor(
    "account API",
    async () =>
      (await fetch(`${API_URL}/api/v1/instance`, { signal: AbortSignal.timeout(2_000) })).ok,
    90_000,
  );
  record(
    "account API ready (production image, dev identity, migrations applied)",
    true,
    { url: API_URL },
    apiMs,
  );

  // The relay fetches JWKS/revocations over the services network by container
  // name, but verifies tokens against the public issuer string.
  await docker(
    "run",
    "-d",
    "--name",
    CONTAINERS.relay,
    "--network",
    NET_SERVICES,
    "-p",
    `${RELAY_PORT}:${RELAY_PORT}`,
    "-e",
    `API_BASE_URL=http://${CONTAINERS.api}:${API_PORT}`,
    "-e",
    `API_ISSUER=${API_URL}/api/v1`,
    "-e",
    `RELAY_SERVICE_TOKEN=${relayServiceToken}`,
    "-e",
    `RELAY_PORT=${RELAY_PORT}`,
    "synara-e2e/relay:local",
  );
  const relayMs = await waitFor(
    "relay",
    async () => (await fetch(`${RELAY_URL}/healthz`, { signal: AbortSignal.timeout(2_000) })).ok,
    60_000,
  );
  record("relay ready (production image)", true, { url: RELAY_URL }, relayMs);
}

// ── Owner sign-in through the real API (dev identity → OTP on stdout) ─

async function signInOwner(): Promise<{ userId: string; accessToken: string; orgId: string }> {
  const account = createAccountClient({ baseUrl: API_URL });
  const startedAt = Date.now();
  await account.sendOtp({ email: OWNER_EMAIL });
  const pattern = new RegExp(
    `\\[dev-identity\\] OTP for ${OWNER_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (\\d{6})`,
  );
  let code: string | undefined;
  await waitFor(
    "OTP code in the API's stdout",
    async () => {
      code = pattern.exec(await dockerQuiet("logs", CONTAINERS.api))?.[1];
      return Boolean(code);
    },
    15_000,
    250,
  );
  const unscoped = await account.authenticateOtp({ email: OWNER_EMAIL, code: code as string });
  // The first workspace-scoped call answers 403 organization_required listing
  // the personal workspace the API just provisioned; refresh into it.
  let orgId: string | undefined;
  try {
    await account.listHosts(unscoped.accessToken);
  } catch (error) {
    if (error instanceof OrganizationRequiredError) orgId = error.organizations[0]?.id;
    else throw error;
  }
  if (!orgId) throw new Error("expected organization_required after an unscoped OTP sign-in");
  const scoped = await account.refreshAccessToken({
    refreshToken: unscoped.refreshToken,
    organizationId: orgId,
  });
  record(
    "owner signed in via OTP and scoped to the personal workspace",
    true,
    { userId: scoped.user.id, email: scoped.user.email, orgId },
    Date.now() - startedAt,
  );
  return { userId: scoped.user.id, accessToken: scoped.accessToken, orgId };
}

// ── The real host on this machine ─────────────────────────────────────

function hostEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SYNARA_HOME: HOME,
    SYNARA_ACCOUNT_URL: API_URL,
    SYNARA_NO_BROWSER: "1",
    ...extra,
  };
}

async function enrollHostHeadlessly(owner: { accessToken: string }): Promise<{ hostId: string }> {
  const startedAt = Date.now();
  const account = createAccountClient({ baseUrl: API_URL });
  const child = spawn(
    "bun",
    [path.join(REPO, "apps/server/src/index.ts"), "auth", "--device-code"],
    {
      cwd: PROJECT,
      env: hostEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const linkLog = await fs.open(path.join(LOGS, "host-link.log"), "w");
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
    void linkLog.write(chunk);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));

  await waitFor(
    "the device-code prompt",
    async () => /enter code [A-Z2-9]{8}/.test(output),
    60_000,
    100,
  );
  const userCode = /enter code ([A-Z2-9]{8})/.exec(output)?.[1] as string;
  // The owner approves "from another device" — here, this orchestrator.
  await account.approveDeviceHostLink(owner.accessToken, { userCode });
  const code = await exited;
  await linkLog.close();
  if (code !== 0 || !/Linked this host as/.test(output)) {
    throw new Error(`headless host link failed (exit ${code}):\n${output}`);
  }
  const stored = JSON.parse(
    await fs.readFile(path.join(HOME, "account-credentials.json"), "utf8"),
  ) as { hostId?: string; hostKeyGeneration?: number; accessToken?: string };
  if (!stored.hostId) throw new Error("device-code link did not persist a host id");
  record(
    "host enrolled headlessly via the device-code flow (`synara auth --device-code`)",
    true,
    {
      hostId: stored.hostId,
      keyGeneration: stored.hostKeyGeneration,
      userCode,
      storedUserToken: stored.accessToken !== undefined,
    },
    Date.now() - startedAt,
  );
  return { hostId: stored.hostId };
}

async function startHost(hostId: string): Promise<void> {
  const hostLog = await fs.open(path.join(LOGS, "host.log"), "w");
  // Bound to every interface so the host's port is genuinely reachable on the
  // LAN IP — the isolated client's failure to reach it then proves the packet
  // filter, not a loopback bind. A non-loopback bind requires the auth token
  // and the explicit plaintext acknowledgement.
  hostProcess = spawn("bun", [path.join(REPO, "apps/server/src/index.ts")], {
    cwd: PROJECT,
    env: hostEnv({
      SYNARA_MODE: "web",
      SYNARA_PORT: String(HOST_PORT),
      SYNARA_HOST: "0.0.0.0",
      SYNARA_AUTH_TOKEN: hostAuthToken,
      SYNARA_ALLOW_INSECURE_REMOTE: "1",
      SYNARA_RELAY_URL: RELAY_URL,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  hostProcess.stdout?.on("data", (chunk) => void hostLog.write(chunk));
  hostProcess.stderr?.on("data", (chunk) => void hostLog.write(chunk));
  hostProcess.on("close", (code) => log(`host process exited ${code}`));
  try {
    const ms = await waitFor(
      "the host's relay control socket",
      () => relayReportsHost(hostId),
      60_000,
    );
    record(
      "real host (apps/server) up, dialed the relay, control socket ready",
      true,
      {
        bind: `0.0.0.0:${HOST_PORT}`,
        relay: RELAY_URL,
      },
      ms,
    );
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\n--- host.log ---\n${await tailLog("host.log", 25)}`,
      { cause: error },
    );
  }
}

// ── The isolated client ──────────────────────────────────────────────

async function positiveControl(): Promise<void> {
  // An UNRESTRICTED container on the client network reaches the host's port
  // directly. Without this, the isolated container's failure to reach it
  // would be indistinguishable from the host not listening.
  const startedAt = Date.now();
  await dockerQuiet("rm", "-f", CONTAINERS.control);
  const status = await sh(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      CONTAINERS.control,
      "--network",
      NET_CLIENT,
      "curlimages/curl:8.10.1",
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "5",
      `http://${lanIp}:${HOST_PORT}/`,
    ],
    { allowFailure: true },
  );
  const reachable = /^[1-5]\d\d$/.test(status);
  record(
    "control: an unrestricted container reaches the host's port directly",
    reachable,
    { url: `http://${lanIp}:${HOST_PORT}/`, httpStatus: status || "no response" },
    Date.now() - startedAt,
  );
  if (!reachable)
    throw new Error("positive control failed: the host is not reachable from Docker at all");
}

async function runIsolatedClient(input: {
  owner: { userId: string; accessToken: string };
  hostId: string;
  phase: "full" | "reconnect" | "agent";
}): Promise<boolean> {
  const forbidden = [
    `http://${lanIp}:${HOST_PORT}/`, // the host, same IP the API/relay are allowed on
    `http://host.docker.internal:${HOST_PORT}/`, // the host by Docker's name for this machine
    `http://${CONTAINERS.api}:${API_PORT}/`, // the API container directly (other network)
    "http://example.com/", // the internet
  ];
  await dockerQuiet("rm", "-f", CONTAINERS.client);
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      CONTAINERS.client,
      "--network",
      NET_CLIENT,
      "--cap-add",
      "NET_ADMIN",
      "-e",
      `SYNARA_E2E_ALLOW_IP=${lanIp}`,
      "-e",
      `SYNARA_E2E_ALLOW_PORTS=${API_PORT},${RELAY_PORT}`,
      "-e",
      `SYNARA_E2E_API_URL=${API_URL}`,
      "-e",
      `SYNARA_E2E_RELAY_URL=${RELAY_URL}`,
      "-e",
      `SYNARA_E2E_ACCESS_TOKEN=${input.owner.accessToken}`,
      "-e",
      `SYNARA_E2E_USER_ID=${input.owner.userId}`,
      "-e",
      `SYNARA_E2E_HOST_ID=${input.hostId}`,
      "-e",
      `SYNARA_E2E_PHASE=${input.phase}`,
      "-e",
      `SYNARA_E2E_AGENT_MODEL=${process.env.SYNARA_E2E_AGENT_MODEL ?? "claude-sonnet-5"}`,
      "-e",
      `SYNARA_E2E_AGENT_WORKSPACE=${PROJECT}`,
      "-e",
      `SYNARA_E2E_FORBIDDEN_URLS=${forbidden.join(",")}`,
      "synara-e2e/client:local",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const clientLog = await fs.open(path.join(LOGS, `client-${input.phase}.log`), "w");
  let buffer = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    void clientLog.write(chunk);
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          step?: string;
          ok?: boolean;
          ms?: number;
          summary?: boolean;
        } & Record<string, unknown>;
        if (parsed.summary) continue;
        const { step, ok, ms, ...detail } = parsed;
        record(`[isolated client · ${input.phase}] ${step}`, Boolean(ok), detail, ms);
      } catch {
        log(`client: ${line}`);
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    void clientLog.write(chunk);
    stderr += chunk.toString();
  });
  const code = await new Promise<number>((resolve) =>
    child.on("close", (exitCode) => resolve(exitCode ?? 1)),
  );
  await clientLog.close();
  if (code !== 0) {
    log(
      `client (${input.phase}) exited ${code}; stderr tail:\n${stderr.trim().split("\n").slice(-12).join("\n")}`,
    );
  }
  return code === 0;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  log(`this machine: ${lanIp}  api: ${API_URL}  relay: ${RELAY_URL}  host: 0.0.0.0:${HOST_PORT}`);
  let ok = true;
  try {
    await startInfrastructure();
    if (stackOnly) {
      console.log("");
      console.log("Stack is up and will stay up (SYNARA_E2E_STACK_ONLY=1).");
      console.log(`  SYNARA_ACCOUNT_URL=${API_URL}`);
      console.log(`  SYNARA_RELAY_URL=${RELAY_URL}`);
      console.log(`  OTP codes:  docker logs -f ${CONTAINERS.api} | grep dev-identity`);
      console.log(`  Tear down:  docker rm -f ${Object.values(CONTAINERS).join(" ")}`);
      return;
    }
    const owner = await signInOwner();
    const { hostId } = await enrollHostHeadlessly(owner);
    await startHost(hostId);
    await positiveControl();

    ok = (await runIsolatedClient({ owner, hostId, phase: "full" })) && ok;

    // Reliability under failure: restart the relay under a live host. The
    // host's supervisor must re-dial with a fresh ticket, and a brand-new
    // device must get through afterwards.
    const restartAt = Date.now();
    await docker("restart", CONTAINERS.relay);
    await waitFor(
      "the host to re-register after the relay restart",
      () => relayReportsHost(hostId),
      90_000,
    );
    record("host re-dialed the relay after a relay restart", true, {}, Date.now() - restartAt);
    ok = (await runIsolatedClient({ owner, hostId, phase: "reconnect" })) && ok;

    // A real agent turn. The provider call runs on the host with whatever
    // Claude credential THIS machine has; the isolated client only ever sees
    // orchestration commands and the thread event stream. Opt-in: it spends
    // provider quota and needs a working Claude login here.
    if (process.env.SYNARA_E2E_AGENT !== "0") {
      ok = (await runIsolatedClient({ owner, hostId, phase: "agent" })) && ok;
    }
  } catch (error) {
    ok = false;
    record("run aborted", false, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    await captureContainerLogs();
    await teardown();
  }

  const passed = rows.filter((row) => row.ok).length;
  const verdict = ok && passed === rows.length;
  console.log("");
  console.log(
    `${verdict ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${passed}/${rows.length} steps in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — logs: ${LOGS}`,
  );
  await fs.writeFile(path.join(LOGS, "results.json"), JSON.stringify(rows, null, 2));
  process.exit(verdict ? 0 : 1);
}

process.on("SIGINT", () => void teardown().then(() => process.exit(130)));
await main();
