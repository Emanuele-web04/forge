// FILE: localServerMonitor.ts
// Purpose: Finds local development servers listening on localhost/private ports and
//          stops a selected server process after re-validating it is still a dev listener.
// Layer: Server runtime utility used by the WebSocket RPC layer.
// Depends on: node child_process lsof/ps output and shared server contract shapes.

import { execFile } from "node:child_process";
import path from "node:path";

import type {
  ServerListLocalServersResult,
  ServerLocalServerAddress,
  ServerLocalServerProcess,
  ServerStopLocalServerInput,
  ServerStopLocalServerResult,
} from "@synara/contracts";

import { redactSensitiveProcessArgs } from "./processArgumentRedaction";

const PROCESS_OUTPUT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const STOP_SIGNAL_SETTLE_MS = 450;
const MAX_PROCESS_ARGS_CHARS = 1_000;
const PROCESS_LINEAGE_MAX_DEPTH = 4;
const PAGE_TITLE_MAX_CHARS = 200;
const PAGE_TITLE_FETCH_TIMEOUT_MS = 650;
const PAGE_TITLE_MAX_BYTES = 128 * 1024;
const PAGE_TITLE_SUCCESS_TTL_MS = 30_000;
const PAGE_TITLE_FAILURE_TTL_MS = 10_000;
const PAGE_TITLE_FETCH_CONCURRENCY = 4;
const PAGE_TITLE_MAX_URLS_PER_SERVER = 3;
const PAGE_TITLE_REDIRECT_LIMIT = 3;
const PAGE_TITLE_CACHE_MAX = 250;

export interface ParsedLsofListener {
  readonly pid: number;
  readonly command: string;
  readonly protocol: "tcp";
  readonly host: string;
  readonly port: number;
  readonly family: ServerLocalServerAddress["family"];
}

export interface LocalServerProcessInfo {
  readonly ppid: number;
  readonly commandLine: string;
  /** Unredacted process-table text retained only for internal classification. */
  readonly rawCommandLine?: string;
}

interface DevServerCandidateInput {
  readonly command: string;
  readonly args: string;
  readonly ports: readonly number[];
}

interface CachedPageTitle {
  readonly title: string | null;
  readonly expiresAtMs: number;
}

const EXCLUDED_PROCESS_PATTERNS = [
  "airplayxpchelper",
  "controlcenter",
  "cursor helper",
  "figma",
  "google chrome",
  "linear helper",
  "logioptionsplus",
  "rapportd",
  "raycast",
  "safari",
  "spotify",
];

const EXCLUDED_PROCESS_COMMANDS = new Set([
  "electron",
  "electron helper",
  "electron helper (renderer)",
  "synara",
]);

// Chromium/Electron spawns child processes (renderers, GPU, utility, plugin hosts) that can hold
// a localhost port yet are app internals, never dev servers — e.g. Discord's RPC helper sits on
// :6463, inside the broad dev-port range. The `--type=` flag is Chromium's own child-process
// marker, so it's a precise signal independent of which app spawned it.
const CHROMIUM_CHILD_ARGS_PATTERN =
  /--type=(?:renderer|gpu-process|gpu|utility|zygote|plugin|ppapi|broker|crashpad-handler)\b/i;

// Electron/Chromium per-role helper executables ("Discord Helper (Renderer)", "Slack Helper
// (GPU)") — matched by name so they're filtered even when the full arg list is unavailable.
const APP_HELPER_COMMAND_PATTERN = /\bhelper\s*\((?:renderer|gpu|plugin|alerts)\)/i;

const DEV_COMMAND_LABELS = new Map<string, string>([
  ["air", "Air"],
  ["artisan", "Laravel"],
  ["astro", "Astro"],
  ["bunx", "Bun"],
  ["expo", "Expo"],
  ["flask", "Flask"],
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["parcel", "Parcel"],
  ["rails", "Rails"],
  ["serve", "Serve"],
  ["vite", "Vite"],
  ["webpack-dev-server", "Webpack"],
]);

const DATABASE_OR_SYSTEM_COMMANDS = new Set([
  "memcached",
  "mongod",
  "mysql",
  "mysqld",
  "postgres",
  "postgresql",
  "redis-server",
]);

const DEV_SCRIPT_NAME_PATTERN =
  /^(?:dev|dev[:_-].+|.+[:_-]dev|electron:dev|dev:electron|dev:desktop|desktop:dev|start:desktop)$/i;
const DEV_ARGS_PATTERN =
  /\b(astro|expo|flask|next\s+dev|nodemon|nuxt|parcel|react-scripts\s+start|remix|rsbuild|rspack|svelte-kit|turbo|vite|webpack-dev-server)\b|(?:manage\.py\s+runserver)|(?:php\s+(?:artisan\s+serve|-S\s+))|(?:rails\s+(?:s|server))|(?:uvicorn\b)|(?:webpack\s+serve)|(?:go\s+run\b)|(?:cargo\s+run\b)|(?:dotnet\s+(?:watch|run)\b)|(?:deno\s+(?:task\s+)?(?:dev|serve|run)\b)|(?:python3?\s+-m\s+http\.server\b)|(?:dev-runner\.[cm]?ts\s+dev[:_-][A-Za-z0-9:_-]+)/i;

const pageTitleCache = new Map<string, CachedPageTitle>();
const pageTitleInFlight = new Map<string, Promise<string | null>>();
// Preserve lineage-only command context without extending the public local-server contract.
const pageTitleProbeArgs = new WeakMap<ServerLocalServerProcess, string>();

function execFileText(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", maxBuffer: PROCESS_OUTPUT_MAX_BUFFER_BYTES },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseLsofEndpoint(
  name: string,
  protocol: ParsedLsofListener["protocol"],
): Pick<ParsedLsofListener, "host" | "port" | "family"> | null {
  const cleaned = name.replace(/\s+\(LISTEN\)$/i, "").trim();
  const bracketMatch = /^\[([^\]]+)\]:(\d+)$/.exec(cleaned);
  if (bracketMatch) {
    const port = Number(bracketMatch[2]);
    return Number.isInteger(port) && port > 0 && port <= 65_535
      ? { host: bracketMatch[1] ?? "::", port, family: "tcp6" }
      : null;
  }

  const separatorIndex = cleaned.lastIndexOf(":");
  if (separatorIndex < 0) {
    return null;
  }

  const rawHost = cleaned.slice(0, separatorIndex).trim();
  const rawPort = cleaned.slice(separatorIndex + 1).trim();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }

  const host = rawHost.length > 0 ? rawHost : "*";
  return {
    host,
    port,
    family: host.includes(":") ? "tcp6" : protocol === "tcp" && host === "*" ? "tcp" : "tcp4",
  };
}

// Parses `lsof -F pcPn` listener records into one row per listening address.
export function parseLsofTcpListenOutput(output: string): ParsedLsofListener[] {
  const listeners: ParsedLsofListener[] = [];
  let currentPid: number | null = null;
  let currentCommand = "";
  let currentProtocol: ParsedLsofListener["protocol"] = "tcp";

  for (const rawLine of output.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (line.length < 2) {
      continue;
    }

    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      const pid = Number(value);
      currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
      currentCommand = "";
      currentProtocol = "tcp";
      continue;
    }
    if (field === "c") {
      currentCommand = value.trim();
      continue;
    }
    if (field === "P") {
      currentProtocol = "tcp";
      continue;
    }
    if (field !== "n" || currentPid === null) {
      continue;
    }

    const endpoint = parseLsofEndpoint(value, currentProtocol);
    if (!endpoint) {
      continue;
    }
    listeners.push({
      pid: currentPid,
      command: currentCommand || "unknown",
      protocol: currentProtocol,
      ...endpoint,
    });
  }

  return listeners;
}

// Parses `lsof -d cwd -Fn` records into a pid -> working-directory map. Each
// process appears as a `p<pid>` line followed by an `n<path>` line for its cwd.
export function parseLsofCwdOutput(output: string): Map<number, string> {
  const cwdByPid = new Map<number, string>();
  let currentPid: number | null = null;
  for (const rawLine of output.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (line.length < 2) {
      continue;
    }
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      const pid = Number(value);
      currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
      continue;
    }
    if (field !== "n" || currentPid === null) {
      continue;
    }
    const cwd = value.trim();
    if (cwd.length > 0 && !cwdByPid.has(currentPid)) {
      cwdByPid.set(currentPid, cwd);
    }
  }
  return cwdByPid;
}

export function parseProcessInfo(output: string): Map<number, LocalServerProcessInfo> {
  const rows = new Map<number, LocalServerProcessInfo>();
  for (const line of output.split(/\r?\n/g)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const rawCommandLine = match[3] ?? "";
    rows.set(Number(match[1]), {
      ppid: Number(match[2]),
      commandLine: redactSensitiveProcessArgs(rawCommandLine, {
        truncateSensitiveEnvironmentRemainder: true,
      }).slice(0, MAX_PROCESS_ARGS_CHARS),
      rawCommandLine,
    });
  }
  return rows;
}

function tokenizeCommandLine(commandLine: string): string[] {
  return [...commandLine.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    .filter((token) => token.length > 0);
}

function commandTokenName(token: string): string {
  return path
    .basename(token)
    .replace(/\.[cm]?js$/i, "")
    .toLowerCase();
}

function normalizeCommandName(command: string, args: string): string {
  return commandTokenName(tokenizeCommandLine(args)[0] ?? command);
}

function processCommandTokens(command: string, args: string): string[] {
  return tokenizeCommandLine(`${command} ${args}`);
}

function isExpoDevServerCommand(command: string, args: string): boolean {
  return processCommandTokens(command, args).some((token) => {
    const normalizedToken = token.replaceAll("\\", "/").toLowerCase();
    return (
      commandTokenName(token) === "expo" || normalizedToken.includes("/node_modules/@expo/cli/")
    );
  });
}

function isMetroDevServerCommand(command: string, args: string): boolean {
  const tokens = processCommandTokens(command, args);
  const tokenNames = tokens.map(commandTokenName);
  const reactNativeIndex = tokenNames.indexOf("react-native");
  return (
    tokenNames.includes("metro") ||
    tokens.some((token) =>
      token.replaceAll("\\", "/").toLowerCase().includes("/node_modules/metro/"),
    ) ||
    (reactNativeIndex >= 0 && tokenNames.slice(reactNativeIndex + 1).includes("start"))
  );
}

// Some dev tools let a generic child own the port while the parent has the useful command.
function processLineageCommandLines(
  pid: number,
  processInfoByPid: ReadonlyMap<number, LocalServerProcessInfo>,
): string | null {
  const commandLines: string[] = [];
  const seen = new Set<number>();
  let currentPid = pid;

  for (let depth = 0; depth < PROCESS_LINEAGE_MAX_DEPTH; depth++) {
    if (seen.has(currentPid)) {
      break;
    }
    seen.add(currentPid);

    const processInfo = processInfoByPid.get(currentPid);
    if (!processInfo) {
      break;
    }
    const commandLine = processInfo.rawCommandLine ?? processInfo.commandLine;
    if (commandLine) {
      commandLines.push(commandLine);
    }
    if (processInfo.ppid <= 1) {
      break;
    }
    currentPid = processInfo.ppid;
  }

  return commandLines.length > 0 ? commandLines.join(" ") : null;
}

function normalizeProcessText(command: string, args: string): string {
  return `${command} ${args}`.toLowerCase();
}

export function isIgnoredLocalServerProcess(input: DevServerCandidateInput): boolean {
  const text = normalizeProcessText(input.command, input.args);
  const commandName = normalizeCommandName(input.command, input.args);
  if (input.ports.every((port) => port < 1024)) {
    return true;
  }
  if (DATABASE_OR_SYSTEM_COMMANDS.has(commandName)) {
    return true;
  }
  if (
    CHROMIUM_CHILD_ARGS_PATTERN.test(input.args) ||
    APP_HELPER_COMMAND_PATTERN.test(input.command)
  ) {
    return true;
  }
  if (EXCLUDED_PROCESS_COMMANDS.has(commandName)) {
    return true;
  }
  return EXCLUDED_PROCESS_PATTERNS.some((pattern) => text.includes(pattern));
}

function isDevScriptName(scriptName: string): boolean {
  return DEV_SCRIPT_NAME_PATTERN.test(scriptName);
}

function devScriptNameFromArgs(args: string): string | null {
  const match = /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_-]+)\b/i.exec(args);
  return match?.[1] ?? null;
}

function detectDevServerKindFromText(input: DevServerCandidateInput): string | null {
  const commandName = normalizeCommandName(input.command, input.args);
  const text = normalizeProcessText(input.command, input.args);
  if (isExpoDevServerCommand(input.command, input.args)) return "Expo";
  if (isMetroDevServerCommand(input.command, input.args)) return "Metro";

  const directToolLabel = DEV_COMMAND_LABELS.get(commandName);
  if (directToolLabel) {
    if (commandName === "next" && !/\bnext\s+dev\b/i.test(input.args)) return null;
    return directToolLabel;
  }
  if (/(^|[\s/\\])vite(?:\.js|\.mjs|\.cjs)?(?:\s|$)/i.test(text)) {
    return "Vite";
  }
  if (/\bnext\s+dev\b/i.test(text)) return "Next.js";
  if (/\bnuxt\b/i.test(text)) return "Nuxt";
  if (/\bastro\b/i.test(text)) return "Astro";
  if (/\bwebpack(?:-dev-server|\s+serve)\b/i.test(text)) return "Webpack";
  if (/\bparcel\b/i.test(text)) return "Parcel";
  if (/\buvicorn\b/i.test(text)) return "Uvicorn";
  if (/\bflask\b/i.test(text)) return "Flask";
  if (/(?:manage\.py\s+runserver)|\bdjango\b/i.test(text)) return "Django";
  if (/(?:php\s+artisan\s+serve)|\blaravel\b/i.test(text)) return "Laravel";
  if (/\brails\s+(?:s|server)\b/i.test(text)) return "Rails";
  if (/\bgo\s+run\b/i.test(text)) return "Go";
  if (/\bcargo\s+run\b/i.test(text)) return "Cargo";
  if (/\bdotnet\s+(?:watch|run)\b/i.test(text)) return "Dotnet";
  if (/\bdeno\s+(?:task\s+)?(?:dev|serve|run)\b/i.test(text)) return "Deno";
  if (/\bpython3?\s+-m\s+http\.server\b/i.test(text)) return "Python";
  if (/\bphp\s+-S\s+/i.test(text)) return "PHP";
  if (/\breact-scripts\s+start\b/i.test(text)) return "React";

  const scriptName = devScriptNameFromArgs(input.args);
  if (scriptName && isDevScriptName(scriptName)) {
    return "Dev Server";
  }

  if (DEV_ARGS_PATTERN.test(text)) return "Dev Server";
  return null;
}

export function isLikelyDevServerProcess(input: DevServerCandidateInput): boolean {
  return !isIgnoredLocalServerProcess(input) && detectDevServerKindFromText(input) !== null;
}

function addressUrl(address: Omit<ServerLocalServerAddress, "url">): string | null {
  if (address.port <= 0) {
    return null;
  }
  if (address.host === "*" || address.host === "0.0.0.0" || address.host === "::") {
    return `http://localhost:${address.port}`;
  }
  if (address.host.includes(":")) {
    return `http://[${address.host}]:${address.port}`;
  }
  return `http://${address.host}:${address.port}`;
}

function normalizePageTitle(input: string): string | null {
  const stripped = input.replace(/<[^>]*>/g, " ");
  const decoded = stripped
    .replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
      const normalized = entity.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "apos") return "'";
      if (normalized === "gt") return ">";
      if (normalized === "lt") return "<";
      if (normalized === "nbsp") return " ";
      if (normalized === "quot") return '"';
      if (normalized.startsWith("#x")) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      if (normalized.startsWith("#")) {
        const codePoint = Number.parseInt(normalized.slice(1), 10);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      return match;
    })
    .replace(/\s+/g, " ")
    .trim();

  if (decoded.length === 0) {
    return null;
  }
  return decoded.length <= PAGE_TITLE_MAX_CHARS
    ? decoded
    : `${decoded.slice(0, PAGE_TITLE_MAX_CHARS - 3).trimEnd()}...`;
}

function extractMetaContent(html: string, names: readonly string[]): string | null {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const rawTag = tag[0];
    const nameMatch = /\b(?:name|property)=["']?([^"'\s>]+)["']?/i.exec(rawTag);
    if (!nameMatch || !names.includes(nameMatch[1]?.toLowerCase() ?? "")) {
      continue;
    }
    const contentMatch =
      /\bcontent=(["'])(.*?)\1/i.exec(rawTag) ?? /\bcontent=([^"'\s>]+)/i.exec(rawTag);
    const content = contentMatch?.[2] ?? contentMatch?.[1] ?? "";
    const normalized = normalizePageTitle(content);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

// Pulls a human label from small HTML previews without depending on a DOM runtime.
export function extractLocalServerPageTitle(html: string): string | null {
  const metaTitle = extractMetaContent(html, ["application-name", "og:title", "twitter:title"]);
  if (metaTitle) {
    return metaTitle;
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return titleMatch ? normalizePageTitle(titleMatch[1] ?? "") : null;
}

async function readResponsePrefix(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  try {
    while (bytesRead < PAGE_TITLE_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const nextChunk = value.slice(0, Math.max(0, PAGE_TITLE_MAX_BYTES - bytesRead));
      bytesRead += nextChunk.byteLength;
      text += decoder.decode(nextChunk, { stream: true });
      if (bytesRead >= PAGE_TITLE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    text += decoder.decode();
  }
  return text;
}

function parseIpv4Host(host: string): readonly [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN)) as [
    number,
    number,
    number,
    number,
  ];
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

function isLocalPageTitleHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::" || host === "::1") {
    return true;
  }
  if (host.startsWith("::ffff:")) {
    return isLocalPageTitleHost(host.slice("::ffff:".length));
  }
  if (
    host.includes(":") &&
    (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))
  ) {
    return true;
  }

  const ipv4 = parseIpv4Host(host);
  if (!ipv4) {
    return false;
  }
  const [first, second] = ipv4;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

// Title probes must stay on local/private hosts even when a dev server redirects.
function isLocalPageTitleProbeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLocalPageTitleHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function resolveLocalPageTitleRedirect(location: string | null, currentUrl: string): string | null {
  if (!location) {
    return null;
  }
  try {
    const nextUrl = new URL(location, currentUrl).toString();
    return isLocalPageTitleProbeUrl(nextUrl) ? nextUrl : null;
  } catch {
    return null;
  }
}

async function fetchLocalPageTitleResponse(
  url: string,
  redirectsRemaining = PAGE_TITLE_REDIRECT_LIMIT,
): Promise<Response | null> {
  if (!isLocalPageTitleProbeUrl(url)) {
    return null;
  }
  const response = await globalThis.fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(PAGE_TITLE_FETCH_TIMEOUT_MS),
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      "User-Agent": "SynaraLocalServerMonitor/1.0",
    },
  });
  if (response.status >= 300 && response.status < 400) {
    if (redirectsRemaining <= 0) {
      return null;
    }
    const redirectUrl = resolveLocalPageTitleRedirect(response.headers.get("location"), url);
    return redirectUrl ? fetchLocalPageTitleResponse(redirectUrl, redirectsRemaining - 1) : null;
  }
  return response;
}

async function fetchPageTitleFromUrl(url: string): Promise<string | null> {
  try {
    const response = await fetchLocalPageTitleResponse(url);
    if (!response?.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !/(?:text\/html|application\/xhtml\+xml)/.test(contentType)) {
      return null;
    }

    return extractLocalServerPageTitle(await readResponsePrefix(response));
  } catch {
    return null;
  }
}

function storePageTitleCacheEntry(url: string, entry: CachedPageTitle): void {
  pageTitleCache.set(url, entry);
  while (pageTitleCache.size > PAGE_TITLE_CACHE_MAX) {
    const oldestKey = pageTitleCache.keys().next().value as string | undefined;
    if (!oldestKey || oldestKey === url) {
      break;
    }
    pageTitleCache.delete(oldestKey);
  }
}

async function resolvePageTitleFromUrl(url: string): Promise<string | null> {
  const now = Date.now();
  const cached = pageTitleCache.get(url);
  if (cached && cached.expiresAtMs > now) {
    return cached.title;
  }

  const pending = pageTitleInFlight.get(url);
  if (pending) {
    return pending;
  }

  const promise = fetchPageTitleFromUrl(url)
    .then((title) => {
      storePageTitleCacheEntry(url, {
        title,
        expiresAtMs: Date.now() + (title ? PAGE_TITLE_SUCCESS_TTL_MS : PAGE_TITLE_FAILURE_TTL_MS),
      });
      return title;
    })
    .finally(() => {
      pageTitleInFlight.delete(url);
    });

  pageTitleInFlight.set(url, promise);
  return promise;
}

function localServerCandidateUrls(
  addresses: readonly Pick<ServerLocalServerAddress, "url">[],
): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const address of addresses) {
    if (!address.url || seen.has(address.url)) {
      continue;
    }
    seen.add(address.url);
    urls.push(address.url);
    if (urls.length >= PAGE_TITLE_MAX_URLS_PER_SERVER) {
      break;
    }
  }
  return urls;
}

function pageTitleCandidateUrls(server: ServerLocalServerProcess): string[] {
  return localServerCandidateUrls(server.addresses);
}

function allowsPageTitleProbe(server: ServerLocalServerProcess): boolean {
  const detectionArgs = pageTitleProbeArgs.get(server) ?? server.args;
  if (server.displayName === "Expo" || isExpoDevServerCommand(server.command, detectionArgs)) {
    return tokenizeCommandLine(detectionArgs).includes("--web");
  }
  return server.displayName !== "Metro" && !isMetroDevServerCommand(server.command, detectionArgs);
}

async function firstResolvedPageTitle(
  urls: readonly string[],
  fetchTitle: (url: string) => Promise<string | null>,
): Promise<string | null> {
  for (const url of urls) {
    const title = await fetchTitle(url);
    if (title) {
      return title;
    }
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function enrichLocalServerProcessesWithPageTitles(
  servers: readonly ServerLocalServerProcess[],
  fetchTitle: (url: string) => Promise<string | null> = resolvePageTitleFromUrl,
): Promise<ServerLocalServerProcess[]> {
  return mapWithConcurrency(servers, PAGE_TITLE_FETCH_CONCURRENCY, async (server) => {
    if (!allowsPageTitleProbe(server)) {
      return server;
    }
    const pageTitle = await firstResolvedPageTitle(pageTitleCandidateUrls(server), fetchTitle);
    return pageTitle ? { ...server, pageTitle } : server;
  });
}

function isProcessSignalable(pid: number): boolean {
  if (pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function dedupeAddresses(listeners: readonly ParsedLsofListener[]): ServerLocalServerAddress[] {
  const seen = new Set<string>();
  const addresses: ServerLocalServerAddress[] = [];
  for (const listener of listeners) {
    const key = `${listener.family}:${listener.host}:${listener.port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const baseAddress = {
      host: listener.host,
      port: listener.port,
      family: listener.family,
    };
    addresses.push({
      ...baseAddress,
      url: addressUrl(baseAddress),
    });
  }
  return addresses.toSorted(
    (left, right) => left.port - right.port || left.host.localeCompare(right.host),
  );
}

function toServerProcess(
  pid: number,
  listeners: readonly ParsedLsofListener[],
  processInfoByPid: ReadonlyMap<number, LocalServerProcessInfo>,
  cwdByPid: ReadonlyMap<number, string>,
): ServerLocalServerProcess | null {
  if (pid === process.pid) {
    return null;
  }

  const addresses = dedupeAddresses(listeners);
  const ports = [...new Set(addresses.map((address) => address.port))].toSorted(
    (left, right) => left - right,
  );
  const command = listeners[0]?.command ?? "unknown";
  const processInfo = processInfoByPid.get(pid);
  const args = processInfo?.commandLine ?? command;
  const detectionArgs = processLineageCommandLines(pid, processInfoByPid) ?? args;
  const candidate = { command, args: detectionArgs, ports };
  if (isIgnoredLocalServerProcess(candidate)) {
    return null;
  }
  const displayName = detectDevServerKindFromText(candidate);
  if (!displayName) {
    return null;
  }

  const isStoppable = isProcessSignalable(pid);
  const cwd = resolveProcessCwd(pid, processInfoByPid, cwdByPid);
  const server: ServerLocalServerProcess = {
    id: `${pid}:${ports.join(",")}`,
    pid,
    ...(typeof processInfo?.ppid === "number" && processInfo.ppid > 0
      ? { ppid: processInfo.ppid }
      : {}),
    command,
    displayName,
    ...(cwd ? { cwd } : {}),
    args,
    ports,
    addresses,
    isStoppable,
    ...(isStoppable ? {} : { stopDisabledReason: "Synara cannot signal this process." }),
  };
  pageTitleProbeArgs.set(server, detectionArgs);
  return server;
}

// Resolves the working directory for a listener, walking up the process lineage
// when the listening pid itself has no resolvable cwd (e.g. a generic child that
// inherited the dev tool's directory). Mirrors how command lines are resolved.
function resolveProcessCwd(
  pid: number,
  processInfoByPid: ReadonlyMap<number, LocalServerProcessInfo>,
  cwdByPid: ReadonlyMap<number, string>,
): string | null {
  const seen = new Set<number>();
  let currentPid = pid;
  for (let depth = 0; depth < PROCESS_LINEAGE_MAX_DEPTH; depth++) {
    if (seen.has(currentPid)) {
      break;
    }
    seen.add(currentPid);
    const cwd = cwdByPid.get(currentPid);
    if (cwd) {
      return cwd;
    }
    const ppid = processInfoByPid.get(currentPid)?.ppid;
    if (typeof ppid !== "number" || ppid <= 1) {
      break;
    }
    currentPid = ppid;
  }
  return null;
}

function groupListenersByPid(
  listeners: readonly ParsedLsofListener[],
): Map<number, ParsedLsofListener[]> {
  const grouped = new Map<number, ParsedLsofListener[]>();
  for (const listener of listeners) {
    const group = grouped.get(listener.pid) ?? [];
    group.push(listener);
    grouped.set(listener.pid, group);
  }
  return grouped;
}

async function readLsofListeners(): Promise<ParsedLsofListener[]> {
  if (process.platform === "win32") {
    return [];
  }
  const output = await execFileText("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcPn"]).catch(
    () => "",
  );
  return parseLsofTcpListenOutput(output);
}

async function readProcessInfoBatch(
  pids: readonly number[],
): Promise<Map<number, LocalServerProcessInfo>> {
  if (pids.length === 0 || process.platform === "win32") {
    return new Map();
  }
  const output = await execFileText("ps", [
    "-ww",
    "-o",
    "pid=",
    "-o",
    "ppid=",
    "-o",
    "command=",
    "-p",
    pids.join(","),
  ]).catch(() => "");
  return parseProcessInfo(output);
}

// Resolves each pid's working directory via `lsof -d cwd`. Only user-owned
// processes are reported (which dev servers are); others are silently absent.
async function readProcessCwdBatch(pids: readonly number[]): Promise<Map<number, string>> {
  if (pids.length === 0 || process.platform === "win32") {
    return new Map();
  }
  const output = await execFileText("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")]).catch(
    () => "",
  );
  return parseLsofCwdOutput(output);
}

async function readProcessInfoWithAncestors(
  pids: readonly number[],
): Promise<Map<number, LocalServerProcessInfo>> {
  const allProcessInfo = new Map<number, LocalServerProcessInfo>();
  let pendingPids = [...new Set(pids)].filter((pid) => pid > 1);

  for (let depth = 0; depth < PROCESS_LINEAGE_MAX_DEPTH && pendingPids.length > 0; depth++) {
    const batch = await readProcessInfoBatch(pendingPids);
    const nextPids: number[] = [];
    for (const [pid, processInfo] of batch) {
      allProcessInfo.set(pid, processInfo);
      if (processInfo.ppid > 1 && !allProcessInfo.has(processInfo.ppid)) {
        nextPids.push(processInfo.ppid);
      }
    }
    pendingPids = [...new Set(nextPids)];
  }

  return allProcessInfo;
}

// Builds UI-ready process rows from raw listener rows; exported for focused parser tests.
export function buildLocalServerProcesses(
  listeners: readonly ParsedLsofListener[],
  processInfoByPid: ReadonlyMap<number, LocalServerProcessInfo> = new Map(),
  cwdByPid: ReadonlyMap<number, string> = new Map(),
): ServerLocalServerProcess[] {
  const grouped = groupListenersByPid(listeners);
  const processes: ServerLocalServerProcess[] = [];
  for (const [pid, group] of grouped) {
    const processRow = toServerProcess(pid, group, processInfoByPid, cwdByPid);
    if (processRow) {
      processes.push(processRow);
    }
  }
  return processes.toSorted(
    (left, right) => (left.ports[0] ?? 0) - (right.ports[0] ?? 0) || left.pid - right.pid,
  );
}

export async function listLocalServers(): Promise<ServerListLocalServersResult> {
  const listeners = await readLsofListeners();
  const pids = [...new Set(listeners.map((listener) => listener.pid))];
  const processInfoByPid = await readProcessInfoWithAncestors(pids);
  // Resolve cwd across the full lineage so a generic port-holding child can fall
  // back to its dev-tool parent's directory (cwd is inherited across fork/exec).
  const cwdByPid = await readProcessCwdBatch([...new Set([...pids, ...processInfoByPid.keys()])]);
  const servers = buildLocalServerProcesses(listeners, processInfoByPid, cwdByPid);
  return {
    generatedAt: new Date().toISOString(),
    servers: await enrichLocalServerProcessesWithPageTitles(servers),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Revalidates the pid/port before signaling so stale UI rows cannot kill arbitrary processes.
export async function stopLocalServer(
  input: ServerStopLocalServerInput,
  prevalidatedTarget?: ServerLocalServerProcess | null,
): Promise<ServerStopLocalServerResult> {
  const target =
    prevalidatedTarget !== undefined
      ? prevalidatedTarget
      : (await listLocalServers()).servers.find(
          (server) => server.pid === input.pid && server.ports.includes(input.port),
        );

  if (!target) {
    return {
      pid: input.pid,
      stopped: false,
      message: "That local server is no longer running.",
    };
  }
  if (!target.isStoppable) {
    return {
      pid: input.pid,
      stopped: false,
      message: target.stopDisabledReason ?? "Synara cannot stop this process.",
    };
  }

  try {
    process.kill(input.pid, "SIGTERM");
  } catch (error) {
    return {
      pid: input.pid,
      stopped: false,
      message: error instanceof Error ? error.message : "Failed to stop the local server.",
    };
  }

  await delay(STOP_SIGNAL_SETTLE_MS);
  const stillAlive = isProcessAlive(input.pid);
  return {
    pid: input.pid,
    stopped: !stillAlive,
    message: stillAlive ? "Stop signal sent; the process is still shutting down." : "Stopped.",
  };
}
