import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  EXTERNAL_MCP_CREATE_TIMEOUT_MS,
  EXTERNAL_MCP_DEFAULT_WAIT_MS,
  EXTERNAL_MCP_MAX_WAIT_MS,
  type ExternalMcpPairResult,
} from "@synara/contracts";

import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { ensurePrivateDirectorySync } from "../privatePathPermissions.ts";
import {
  computeExternalMcpRuntimeProof,
  EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER,
  runtimeProofsMatch,
} from "./runtimeProof.ts";

const CLIENT_STORE_VERSION = 1;
const CLIENT_STORE_DIRECTORY = path.join("mcp", "credentials");
const PENDING_PAIRING_DIRECTORY = path.join("mcp", "pending-pairing");
const RUNTIME_CHALLENGE_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_TIMEOUT_MS = 10_000;
const MAX_IN_FLIGHT = 8;
const RUNTIME_STATE_RELATIVE_PATHS = [
  path.join("userdata", "server-runtime.json"),
  path.join("dev", "server-runtime.json"),
] as const;
const WINDOWS_TRUSTED_RUNTIME_ACL_SIDS = new Set([
  "S-1-5-18", // LocalSystem
  "S-1-5-32-544", // Builtin Administrators
]);
const WINDOWS_RUNTIME_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$target = $env:SYNARA_RUNTIME_ACL_TARGET",
  "$item = Get-Item -LiteralPath $target -Force",
  "$acl = Get-Acl -LiteralPath $target",
  "$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$ownerAccount = New-Object System.Security.Principal.NTAccount($acl.Owner)",
  "$ownerSid = $ownerAccount.Translate([System.Security.Principal.SecurityIdentifier]).Value",
  "$sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)",
  "$rawDescriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)",
  "$hasDacl = $null -ne $rawDescriptor.DiscretionaryAcl",
  "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString() } })",
  "[pscustomobject]@{ currentSid = $currentSid; ownerSid = $ownerSid; hasDacl = $hasDacl; isReparsePoint = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint); rules = $rules } | ConvertTo-Json -Compress -Depth 4",
].join("; ");
const WINDOWS_RUNTIME_ACL_ENCODED_COMMAND = Buffer.from(
  WINDOWS_RUNTIME_ACL_SCRIPT,
  "utf16le",
).toString("base64");

export function makeWindowsRuntimeAclPowerShellInvocation(targetPath: string) {
  return {
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_RUNTIME_ACL_ENCODED_COMMAND],
    options: {
      encoding: "utf8" as const,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
      env: { ...process.env, SYNARA_RUNTIME_ACL_TARGET: targetPath },
    },
  };
}

export interface WindowsRuntimeAclSnapshot {
  readonly currentSid: string;
  readonly ownerSid: string;
  readonly hasDacl: boolean;
  readonly isReparsePoint: boolean;
  readonly rules: ReadonlyArray<{
    readonly sid: string;
    readonly type: string;
  }>;
}

export function isOwnerPrivateWindowsRuntimeAcl(snapshot: WindowsRuntimeAclSnapshot): boolean {
  if (!snapshot.hasDacl || snapshot.isReparsePoint || snapshot.ownerSid !== snapshot.currentSid) {
    return false;
  }
  return snapshot.rules.every(
    (rule) =>
      rule.type !== "Allow" ||
      rule.sid === snapshot.currentSid ||
      WINDOWS_TRUSTED_RUNTIME_ACL_SIDS.has(rule.sid),
  );
}

export class ExternalMcpBridgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExternalMcpBridgeError";
  }
}

class ExternalMcpRequestCancelledError extends Error {
  constructor() {
    super("External MCP request cancelled by the client.");
    this.name = "ExternalMcpRequestCancelledError";
  }
}

class ExternalMcpRequestTimeoutError extends ExternalMcpBridgeError {
  constructor(timeoutMs: number) {
    super(`Synara did not respond within ${timeoutMs} ms.`);
    this.name = "ExternalMcpRequestTimeoutError";
  }
}

export interface ExternalMcpClientCredentialStore {
  readonly version: 1;
  readonly integrationId: string;
  readonly name: string;
  readonly credential: string;
  readonly expiresAt: string;
  readonly pairedAt: string;
}

interface PendingPairingStore {
  readonly version: 1;
  readonly credential: string;
  readonly createdAt: string;
}

export type ExternalMcpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function resolveExternalMcpBaseDir(homeDir?: string): string {
  const configured = homeDir?.trim() || process.env.SYNARA_HOME?.trim();
  if (!configured) return path.join(os.homedir(), ".synara");
  if (configured === "~") return os.homedir();
  if (configured.startsWith(`~${path.sep}`) || configured.startsWith("~/")) {
    return path.resolve(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function safeIntegrationId(integrationId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(integrationId)) {
    throw new ExternalMcpBridgeError("Invalid external MCP integration id.");
  }
  return integrationId;
}

export function externalMcpClientStorePath(baseDir: string, integrationId: string): string {
  return path.join(baseDir, CLIENT_STORE_DIRECTORY, `${safeIntegrationId(integrationId)}.json`);
}

function parseRuntimeState(
  raw: string,
  sourcePath: string,
  options: { readonly requireLoopback: boolean },
): PersistedServerRuntimeState {
  try {
    const state = JSON.parse(raw) as Partial<PersistedServerRuntimeState>;
    if (
      state.version !== 1 ||
      !Number.isInteger(state.pid) ||
      !Number.isInteger(state.port) ||
      typeof state.origin !== "string" ||
      typeof state.startedAt !== "string" ||
      typeof state.externalMcpRuntimeSecret !== "string" ||
      state.externalMcpRuntimeSecret.length < 32
    ) {
      throw new Error("invalid runtime-state shape");
    }
    const origin = new URL(state.origin);
    if (origin.protocol !== "http:") {
      throw new Error("runtime origin is not HTTP");
    }
    if (
      options.requireLoopback &&
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(origin.hostname)
    ) {
      throw new Error("runtime origin is not loopback HTTP");
    }
    return state as PersistedServerRuntimeState;
  } catch (cause) {
    throw new ExternalMcpBridgeError(`Invalid Synara runtime-state file: ${sourcePath}`, { cause });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assertPrivateRuntimeStat(
  stat: fs.Stats,
  targetPath: string,
  kind: "file" | "directory",
): void {
  const expectedType = kind === "file" ? stat.isFile() : stat.isDirectory();
  if (!expectedType || stat.isSymbolicLink()) {
    throw new ExternalMcpBridgeError(`Refusing unsafe runtime-state ${kind}: ${targetPath}`);
  }
  if (process.platform === "win32") return;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new ExternalMcpBridgeError(
      `Runtime-state ${kind} ${targetPath} is not owned by the current user.`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new ExternalMcpBridgeError(
      `Runtime-state ${kind} ${targetPath} is accessible by other users.`,
    );
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateWindowsRuntimePath(targetPath: string, kind: "file" | "directory"): void {
  let snapshot: WindowsRuntimeAclSnapshot;
  try {
    const invocation = makeWindowsRuntimeAclPowerShellInvocation(targetPath);
    const raw = execFileSync("powershell.exe", invocation.args, invocation.options);
    const parsed = JSON.parse(raw) as Partial<WindowsRuntimeAclSnapshot>;
    if (
      typeof parsed.currentSid !== "string" ||
      typeof parsed.ownerSid !== "string" ||
      typeof parsed.hasDacl !== "boolean" ||
      typeof parsed.isReparsePoint !== "boolean" ||
      !Array.isArray(parsed.rules) ||
      parsed.rules.some(
        (rule) =>
          typeof rule !== "object" ||
          rule === null ||
          typeof rule.sid !== "string" ||
          typeof rule.type !== "string",
      )
    ) {
      throw new Error("invalid Windows ACL response");
    }
    snapshot = parsed as WindowsRuntimeAclSnapshot;
  } catch (cause) {
    throw new ExternalMcpBridgeError(
      `Could not verify private Windows runtime-state ${kind}: ${targetPath}`,
      { cause },
    );
  }
  if (!isOwnerPrivateWindowsRuntimeAcl(snapshot)) {
    throw new ExternalMcpBridgeError(
      `Runtime-state ${kind} ${targetPath} is not owned by the current user, is accessible by other users, or is a reparse point.`,
    );
  }
}

function readPrivateRuntimeState(sourcePath: string): string {
  const directoryPath = path.dirname(sourcePath);
  const directoryStat = fs.lstatSync(directoryPath);
  assertPrivateRuntimeStat(directoryStat, directoryPath, "directory");
  if (process.platform === "win32") {
    assertPrivateWindowsRuntimePath(directoryPath, "directory");
  }

  const pathStat = fs.lstatSync(sourcePath);
  assertPrivateRuntimeStat(pathStat, sourcePath, "file");
  if (process.platform === "win32") {
    assertPrivateWindowsRuntimePath(sourcePath, "file");
  }
  const flags =
    process.platform === "win32"
      ? fs.constants.O_RDONLY
      : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(sourcePath, flags);
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    assertPrivateRuntimeStat(descriptorStat, sourcePath, "file");
    if (!sameFile(pathStat, descriptorStat)) {
      throw new ExternalMcpBridgeError(
        `Runtime-state file changed while it was being validated: ${sourcePath}`,
      );
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    const directoryAfterRead = fs.lstatSync(directoryPath);
    assertPrivateRuntimeStat(directoryAfterRead, directoryPath, "directory");
    if (!sameFile(directoryStat, directoryAfterRead)) {
      throw new ExternalMcpBridgeError(
        `Runtime-state directory changed while it was being validated: ${directoryPath}`,
      );
    }
    return raw;
  } finally {
    fs.closeSync(descriptor);
  }
}

function discoverRunningRuntime(
  baseDir: string,
  options: { readonly requireLoopback: boolean },
): {
  readonly state: PersistedServerRuntimeState;
  readonly sourcePath: string;
} {
  const candidates = RUNTIME_STATE_RELATIVE_PATHS.flatMap((relativePath) => {
    const sourcePath = path.join(baseDir, relativePath);
    if (!fs.existsSync(sourcePath)) return [];
    const state = parseRuntimeState(readPrivateRuntimeState(sourcePath), sourcePath, options);
    return processIsAlive(state.pid) ? [{ state, sourcePath }] : [];
  });
  if (candidates.length === 0) {
    throw new ExternalMcpBridgeError(
      `No running Synara instance was found under ${baseDir}. Start Synara first or pass --home-dir for the intended instance.`,
    );
  }
  if (candidates.length > 1) {
    throw new ExternalMcpBridgeError(
      `Multiple running Synara instances were found under ${baseDir}: ${candidates.map((candidate) => candidate.state.origin).join(", ")}. Stop one instance or pass a distinct --home-dir.`,
    );
  }
  return candidates[0]!;
}

export function discoverServerRuntime(baseDir: string): {
  readonly state: PersistedServerRuntimeState;
  readonly sourcePath: string;
} {
  return discoverRunningRuntime(baseDir, { requireLoopback: false });
}

export function discoverExternalMcpRuntime(baseDir: string): {
  readonly state: PersistedServerRuntimeState;
  readonly sourcePath: string;
} {
  return discoverRunningRuntime(baseDir, { requireLoopback: true });
}

function assertPrivateFile(filePath: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ExternalMcpBridgeError(`Refusing unsafe credential path: ${filePath}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ExternalMcpBridgeError(
      `Credential file ${filePath} is accessible by other users. Run: chmod 600 ${JSON.stringify(filePath)}`,
    );
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  // Validate both private directory levels with O_NOFOLLOW before writing.
  // A pre-existing baseDir/mcp or leaf symlink must never redirect secrets.
  ensurePrivateDirectorySync(path.dirname(directory));
  ensurePrivateDirectorySync(directory);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(
        directory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (cause) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupCause) {
      if ((cleanupCause as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupCause;
    }
    throw cause;
  }
}

export function writeExternalMcpClientCredential(
  baseDir: string,
  paired: ExternalMcpPairResult,
): string {
  const filePath = externalMcpClientStorePath(baseDir, paired.integrationId);
  if (fs.existsSync(filePath)) {
    const existing = readExternalMcpClientCredential(baseDir, paired.integrationId);
    if (existing.credential !== paired.credential) {
      throw new ExternalMcpBridgeError(
        `Integration ${paired.integrationId} already has a different stored credential. Revoke it in Synara before replacing the local secret.`,
      );
    }
    return filePath;
  }
  writePrivateJson(filePath, {
    version: CLIENT_STORE_VERSION,
    integrationId: paired.integrationId,
    name: paired.name,
    credential: paired.credential,
    expiresAt: paired.expiresAt,
    pairedAt: new Date().toISOString(),
  } satisfies ExternalMcpClientCredentialStore);
  return filePath;
}

export function readExternalMcpClientCredential(
  baseDir: string,
  integrationId?: string,
): ExternalMcpClientCredentialStore {
  const directory = path.join(baseDir, CLIENT_STORE_DIRECTORY);
  const candidates = integrationId
    ? [externalMcpClientStorePath(baseDir, integrationId)]
    : fs.existsSync(directory)
      ? fs
          .readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => path.join(directory, entry.name))
          .toSorted()
      : [];
  if (candidates.length === 0 || !fs.existsSync(candidates[0]!)) {
    throw new ExternalMcpBridgeError(
      integrationId
        ? `No paired external MCP credential was found for integration ${integrationId}. Run its pairing command from Synara Settings.`
        : `No paired external MCP credential was found under ${directory}. Create an integration in Synara Settings, then run its pairing command.`,
    );
  }
  if (candidates.length > 1) {
    const ids = candidates.map((candidate) => path.basename(candidate, ".json"));
    throw new ExternalMcpBridgeError(
      `Multiple paired external MCP integrations were found (${ids.join(", ")}). Pass --integration with the intended id.`,
    );
  }
  const filePath = candidates[0]!;
  assertPrivateFile(filePath);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as Partial<ExternalMcpClientCredentialStore>;
    if (
      parsed.version !== CLIENT_STORE_VERSION ||
      typeof parsed.integrationId !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.credential !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.pairedAt !== "string"
    ) {
      throw new Error("invalid credential-store shape");
    }
    return parsed as ExternalMcpClientCredentialStore;
  } catch (cause) {
    throw new ExternalMcpBridgeError(`Invalid external MCP credential store: ${filePath}`, {
      cause,
    });
  }
}

function pendingPairingPath(baseDir: string, pairingCode: string): string {
  const digest = createHash("sha256").update(pairingCode).digest("hex");
  return path.join(baseDir, PENDING_PAIRING_DIRECTORY, `${digest}.json`);
}

function loadOrCreatePendingPairing(
  baseDir: string,
  pairingCode: string,
): {
  readonly path: string;
  readonly value: PendingPairingStore;
} {
  const filePath = pendingPairingPath(baseDir, pairingCode);
  if (fs.existsSync(filePath)) {
    assertPrivateFile(filePath);
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PendingPairingStore>;
    if (
      value.version !== 1 ||
      typeof value.credential !== "string" ||
      typeof value.createdAt !== "string"
    ) {
      throw new ExternalMcpBridgeError(`Invalid pending external MCP pairing store: ${filePath}`);
    }
    return { path: filePath, value: value as PendingPairingStore };
  }
  const value: PendingPairingStore = {
    version: 1,
    credential: `syn_mcp_v1_${randomBytes(32).toString("base64url")}`,
    createdAt: new Date().toISOString(),
  };
  writePrivateJson(filePath, value);
  return { path: filePath, value };
}

export async function fetchExternalMcpWithTimeout(
  fetchImpl: ExternalMcpFetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  cancellationSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  if (cancellationSignal?.aborted) throw new ExternalMcpRequestCancelledError();
  let rejectCancellation: ((cause: ExternalMcpRequestCancelledError) => void) | null = null;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    controller.abort();
    rejectCancellation?.(new ExternalMcpRequestCancelledError());
  };
  cancellationSignal?.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ExternalMcpRequestTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      timeout,
      cancellation,
    ]);
  } catch (cause) {
    if (cancellationSignal?.aborted) throw new ExternalMcpRequestCancelledError();
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
    cancellationSignal?.removeEventListener("abort", cancel);
  }
}

export async function readExternalMcpResponseText(
  response: Response,
  timeoutMs = RUNTIME_CHALLENGE_TIMEOUT_MS,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const readAll = async () => {
    let result = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return result + decoder.decode();
      result += decoder.decode(chunk.value, { stream: true });
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new ExternalMcpBridgeError(`Synara response body stalled for ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([readAll(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}

async function verifyPersistedServerRuntime(
  runtime: ReturnType<typeof discoverServerRuntime>,
  fetchImpl: ExternalMcpFetch,
): Promise<void> {
  const nonce = randomBytes(24).toString("base64url");
  const response = await fetchExternalMcpWithTimeout(
    fetchImpl,
    new URL("/api/mcp/external/runtime-challenge", runtime.state.origin),
    {
      method: "POST",
      headers: {
        [EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER]: nonce,
        Accept: "application/json",
      },
    },
    RUNTIME_CHALLENGE_TIMEOUT_MS,
  );
  let body: { readonly proof?: unknown } | null;
  try {
    body = JSON.parse(await readExternalMcpResponseText(response)) as {
      readonly proof?: unknown;
    };
  } catch {
    body = null;
  }
  const expected = computeExternalMcpRuntimeProof(runtime.state.externalMcpRuntimeSecret, nonce);
  if (
    !response.ok ||
    typeof body?.proof !== "string" ||
    !runtimeProofsMatch(expected, body.proof)
  ) {
    throw new ExternalMcpBridgeError(
      "The server endpoint did not prove it is the Synara process named by the private runtime-state file.",
    );
  }
}

export async function verifyServerRuntime(
  runtime: ReturnType<typeof discoverServerRuntime>,
  fetchImpl: ExternalMcpFetch,
): Promise<void> {
  await verifyPersistedServerRuntime(runtime, fetchImpl);
}

export async function verifyExternalMcpRuntime(
  runtime: ReturnType<typeof discoverExternalMcpRuntime>,
  fetchImpl: ExternalMcpFetch,
): Promise<void> {
  await verifyPersistedServerRuntime(runtime, fetchImpl);
}

export function requestTimeoutForBody(body: string): number {
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    let serverWorkMs = 0;
    for (const value of messages) {
      if (!value || typeof value !== "object") continue;
      const request = value as {
        method?: unknown;
        params?: { name?: unknown; arguments?: { timeoutMs?: unknown } };
      };
      if (request.method !== "tools/call") continue;
      if (request.params?.name === "synara_create_task") {
        serverWorkMs += EXTERNAL_MCP_CREATE_TIMEOUT_MS;
        continue;
      }
      if (request.params?.name !== "synara_wait_for_task") continue;
      const requestedWaitMs = request.params.arguments?.timeoutMs;
      const waitMs =
        typeof requestedWaitMs === "number" && Number.isFinite(requestedWaitMs)
          ? Math.min(EXTERNAL_MCP_MAX_WAIT_MS, Math.max(0, requestedWaitMs))
          : EXTERNAL_MCP_DEFAULT_WAIT_MS;
      // The HTTP gateway processes batch entries sequentially, so each wait
      // contributes to the request's total server-side duration.
      serverWorkMs += waitMs;
    }
    return Math.max(REQUEST_TIMEOUT_MS, serverWorkMs + 5_000);
  } catch {
    return REQUEST_TIMEOUT_MS;
  }
}

async function fetchWithRestartRecovery(input: {
  readonly baseDir: string;
  readonly credential: string;
  readonly body: string;
  readonly fetchImpl?: ExternalMcpFetch;
  readonly recoveryTimeoutMs?: number;
  readonly cancellationSignal?: AbortSignal;
}): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const deadline = Date.now() + (input.recoveryTimeoutMs ?? RECONNECT_TIMEOUT_MS);
  let lastCause: unknown;
  do {
    try {
      const runtime = discoverExternalMcpRuntime(input.baseDir);
      await verifyExternalMcpRuntime(runtime, fetchImpl);
      return await fetchExternalMcpWithTimeout(
        fetchImpl,
        new URL("/mcp/external", runtime.state.origin),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.credential}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: input.body,
        },
        requestTimeoutForBody(input.body),
        input.cancellationSignal,
      );
    } catch (cause) {
      if (input.cancellationSignal?.aborted) throw new ExternalMcpRequestCancelledError();
      if (cause instanceof ExternalMcpRequestTimeoutError) throw cause;
      lastCause = cause;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  throw new ExternalMcpBridgeError(
    "Could not authenticate and reconnect to Synara. Ensure exactly one intended instance is running.",
    { cause: lastCause },
  );
}

export async function pairExternalMcpClient(input: {
  readonly baseDir: string;
  readonly pairingCode: string;
  readonly fetchImpl?: ExternalMcpFetch;
}): Promise<{ readonly paired: ExternalMcpPairResult; readonly storePath: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const pending = loadOrCreatePendingPairing(input.baseDir, input.pairingCode);
  const requestBody = JSON.stringify({
    pairingCode: input.pairingCode,
    credential: pending.value.credential,
  });
  const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
  let response: Response | null = null;
  let lastCause: unknown;
  do {
    try {
      const runtime = discoverExternalMcpRuntime(input.baseDir);
      await verifyExternalMcpRuntime(runtime, fetchImpl);
      response = await fetchExternalMcpWithTimeout(
        fetchImpl,
        new URL("/api/mcp/external/pair", runtime.state.origin),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: requestBody,
        },
        REQUEST_TIMEOUT_MS,
      );
      break;
    } catch (cause) {
      lastCause = cause;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  if (!response) {
    throw new ExternalMcpBridgeError(
      "Could not reconnect to Synara to complete pairing. The private pending credential was preserved for a safe retry.",
      { cause: lastCause },
    );
  }
  let body: ExternalMcpPairResult | { readonly error?: string } | null;
  try {
    body = JSON.parse(await readExternalMcpResponseText(response)) as
      | ExternalMcpPairResult
      | { readonly error?: string };
  } catch {
    body = null;
  }
  if (!response.ok || !body || !("credential" in body)) {
    throw new ExternalMcpBridgeError(
      (body && "error" in body && body.error) ||
        `Synara rejected external MCP pairing with HTTP ${response.status}.`,
    );
  }
  if (body.credential !== pending.value.credential) {
    throw new ExternalMcpBridgeError(
      "Synara returned a different pairing credential; refusing it.",
    );
  }
  const storePath = writeExternalMcpClientCredential(input.baseDir, body);
  fs.rmSync(pending.path, { force: true });
  return { paired: body, storePath };
}

type JsonRpcId = string | number | null;

function localErrorResponse(line: string, code: number, message: string): string | null {
  const error = (id: JsonRpcId) => ({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    const parsed = JSON.parse(line) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    if (values.length === 0) return JSON.stringify(error(null));
    const responses: Array<ReturnType<typeof error>> = [];
    for (const value of values) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        responses.push(error(null));
        continue;
      }
      const record = value as Record<string, unknown>;
      const validId =
        typeof record.id === "string" || typeof record.id === "number" || record.id === null
          ? (record.id as JsonRpcId)
          : null;
      const validMessage = record.jsonrpc === "2.0" && typeof record.method === "string";
      if (validMessage && !("id" in record)) continue;
      responses.push(error(validId));
    }
    if (responses.length === 0) return null;
    return JSON.stringify(Array.isArray(parsed) ? responses : responses[0]);
  } catch {
    return JSON.stringify(error(null));
  }
}

const jsonRpcRequestKey = (id: string | number) => `${typeof id}:${String(id)}`;

function requestKeysForLine(line: string): ReadonlyArray<string> {
  try {
    const parsed = JSON.parse(line) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      return record.jsonrpc === "2.0" &&
        typeof record.method === "string" &&
        (typeof record.id === "string" || typeof record.id === "number")
        ? [jsonRpcRequestKey(record.id)]
        : [];
    });
  } catch {
    return [];
  }
}

function cancelledRequestKeyForLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.jsonrpc !== "2.0" ||
      "id" in record ||
      record.method !== "notifications/cancelled" ||
      !record.params ||
      typeof record.params !== "object" ||
      Array.isArray(record.params)
    ) {
      return null;
    }
    const requestId = (record.params as Record<string, unknown>).requestId;
    return typeof requestId === "string" || typeof requestId === "number"
      ? jsonRpcRequestKey(requestId)
      : null;
  } catch {
    return null;
  }
}

function writeStream(stream: NodeJS.WritableStream, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, (error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

export async function serveExternalMcpStdio(input: {
  readonly baseDir: string;
  readonly integrationId?: string;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly fetchImpl?: ExternalMcpFetch;
}): Promise<void> {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const credential = readExternalMcpClientCredential(input.baseDir, input.integrationId);
  const lines = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  const inFlight = new Set<Promise<void>>();
  const activeRequests = new Map<string, AbortController>();
  let outputQueue = Promise.resolve();
  const emit = (stream: NodeJS.WritableStream, value: string) => {
    outputQueue = outputQueue.then(() => writeStream(stream, value));
    return outputQueue;
  };
  const handleMessage = async (
    line: string,
    cancellationSignal: AbortSignal,
  ): Promise<string | null> => {
    let response: Response;
    try {
      response = await fetchWithRestartRecovery({
        baseDir: input.baseDir,
        credential: credential.credential,
        body: line,
        cancellationSignal,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
    } catch (cause) {
      if (cause instanceof ExternalMcpRequestCancelledError) return null;
      const message = cause instanceof Error ? cause.message : String(cause);
      await emit(stderr, `[synara mcp] ${message}\n`);
      return localErrorResponse(line, -32603, message);
    }
    if (response.status === 202 || response.status === 204) return null;
    let responseText: string;
    try {
      responseText = await readExternalMcpResponseText(response);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await emit(stderr, `[synara mcp] ${message}\n`);
      return localErrorResponse(line, -32603, message);
    }
    if (response.status === 401) {
      const message =
        "Synara rejected the stored external MCP credential because it was revoked, expired, or replaced. Pair the integration again from Settings.";
      await emit(stderr, `[synara mcp] ${message}\n`);
      return localErrorResponse(line, -32001, message);
    }
    if (!response.ok) {
      if (responseText.trim()) {
        try {
          JSON.parse(responseText);
          return responseText.trim();
        } catch {
          // Fall through to a transport error that preserves request ids.
        }
      }
      const message = `Synara external MCP request failed with HTTP ${response.status}.`;
      await emit(stderr, `[synara mcp] ${message}\n`);
      return localErrorResponse(line, -32603, message);
    }
    return responseText.trim() || null;
  };

  const executeMessage = async (
    line: string,
    cancellation = new AbortController(),
  ): Promise<string | null> => {
    const requestKey = requestKeysForLine(line)[0] ?? null;
    if (requestKey) activeRequests.set(requestKey, cancellation);
    try {
      return await handleMessage(line, cancellation.signal);
    } finally {
      if (requestKey && activeRequests.get(requestKey) === cancellation) {
        activeRequests.delete(requestKey);
      }
    }
  };

  const handleLine = async (line: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      const response = await executeMessage(line);
      if (response) await emit(stdout, `${response}\n`);
      return;
    }
    if (!Array.isArray(parsed)) {
      const response = await executeMessage(line);
      if (response) await emit(stdout, `${response}\n`);
      return;
    }
    if (parsed.length === 0) {
      const response = localErrorResponse(line, -32600, "Invalid Request");
      if (response) await emit(stdout, `${response}\n`);
      return;
    }
    const entries = parsed.map((message) => {
      const line = JSON.stringify(message);
      const requestKey = requestKeysForLine(line)[0] ?? null;
      const cancellation = new AbortController();
      if (requestKey) activeRequests.set(requestKey, cancellation);
      return { line, requestKey, cancellation };
    });
    const responses: Array<unknown> = [];
    for (const entry of entries) {
      const response = await executeMessage(entry.line, entry.cancellation);
      if (!response) continue;
      try {
        const decoded = JSON.parse(response) as unknown;
        if (Array.isArray(decoded)) responses.push(...decoded);
        else responses.push(decoded);
      } catch {
        const fallback = localErrorResponse(entry.line, -32603, "Invalid Synara response");
        if (fallback) responses.push(JSON.parse(fallback) as unknown);
      }
    }
    if (responses.length > 0) await emit(stdout, `${JSON.stringify(responses)}\n`);
  };

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cancelledRequestKey = cancelledRequestKeyForLine(line);
    if (cancelledRequestKey !== null) {
      activeRequests.get(cancelledRequestKey)?.abort();
      continue;
    }
    while (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight);
    let task: Promise<void>;
    task = handleLine(line).finally(() => {
      inFlight.delete(task);
    });
    inFlight.add(task);
  }
  await Promise.all(inFlight);
  await outputQueue;
}
