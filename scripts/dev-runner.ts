#!/usr/bin/env node

import { homedir } from "node:os";
import { delimiter as pathDelimiter, join as pathJoin } from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@synara/shared/Net";
import {
  getBooleanFlagValue,
  optionalBooleanEnvironmentConfig,
  optionalBooleanFlag,
  type BooleanFlagInput,
} from "@synara/shared/cli";
import { applyShellEnvironmentHydrationMarker } from "@synara/shared/shell";
import { Config, Data, Effect, Hash, Layer, Logger, Option, Path, Schema } from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

const BASE_SERVER_PORT = 3773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;

export const DEFAULT_SYNARA_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(homedir(), ".synara"),
);

const MODE_ARGS = {
  dev: [
    "run",
    "dev",
    "--ui=tui",
    "--filter=@synara/contracts",
    "--filter=@synara/web",
    "--filter=@synara/cli",
    "--parallel",
  ],
  "dev:server": ["run", "dev", "--filter=@synara/cli"],
  "dev:web": ["run", "dev", "--filter=@synara/web"],
  "dev:desktop": ["run", "dev", "--filter=@synara/desktop", "--filter=@synara/web", "--parallel"],
} as const satisfies Record<string, ReadonlyArray<string>>;

type DevMode = keyof typeof MODE_ARGS;
type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

class DevRunnerError extends Data.TaggedError("DevRunnerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalUrlConfig = (name: string): Config.Config<URL | undefined> =>
  Config.url(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("SYNARA_PORT_OFFSET"),
  devInstance: optionalStringConfig("SYNARA_DEV_INSTANCE"),
});
const HomeConfig = optionalStringConfig("SYNARA_HOME");
const BooleanEnvConfig = Config.all({
  noBrowser: optionalBooleanEnvironmentConfig("SYNARA_NO_BROWSER"),
  autoBootstrapProjectFromCwd: optionalBooleanEnvironmentConfig(
    "SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
  ),
  logWebSocketEvents: optionalBooleanEnvironmentConfig("SYNARA_LOG_WS_EVENTS"),
});

export const readDevRunnerBooleanEnvironment = (environment: NodeJS.ProcessEnv) => {
  const definedEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return BooleanEnvConfig.parse(ConfigProvider.fromEnv({ env: definedEnvironment })).pipe(
    Effect.mapError(
      (cause) =>
        new DevRunnerError({
          message: "Failed to read boolean development-runner configuration.",
          cause,
        }),
    ),
  );
};

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
}): { readonly offset: number; readonly source: string } {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      throw new Error(`Invalid SYNARA_PORT_OFFSET: ${config.portOffset}`);
    }
    return {
      offset: config.portOffset,
      source: `SYNARA_PORT_OFFSET=${config.portOffset}`,
    };
  }

  const seed = config.devInstance?.trim();
  if (!seed) {
    return { offset: 0, source: "default ports" };
  }

  if (/^\d+$/.test(seed)) {
    return { offset: Number(seed), source: `numeric SYNARA_DEV_INSTANCE=${seed}` };
  }

  const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
  return { offset, source: `hashed SYNARA_DEV_INSTANCE=${seed}` };
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_SYNARA_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly synaraHome: string | undefined;
  readonly authToken: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  synaraHome,
  authToken,
  noBrowser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    const resolvedBaseDir = yield* resolveBaseDir(synaraHome);
    const configuredHost = host ?? "127.0.0.1";
    // Brackets are URL syntax, not valid listen-host syntax. Keep the bind host
    // portable while adding brackets back only when constructing an IPv6 URL.
    const serverHost = configuredHost.replace(/^\[([^\]]+)\]$/, "$1");
    const clientHost =
      serverHost === "0.0.0.0" ? "127.0.0.1" : serverHost === "::" ? "::1" : serverHost;
    const formattedClientHost = clientHost.includes(":")
      ? `[${clientHost.replace(/^\[|\]$/g, "")}]`
      : clientHost;

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      SYNARA_PORT: String(serverPort),
      PORT: String(webPort),
      ELECTRON_RENDERER_PORT: String(webPort),
      VITE_WS_URL: `ws://${formattedClientHost}:${serverPort}`,
      VITE_DEV_SERVER_URL: devUrl?.toString() ?? `http://localhost:${webPort}`,
      SYNARA_HOME: resolvedBaseDir,
      SYNARA_HOST: serverHost,
    };

    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const existingPath = output[pathKey] ?? output.PATH ?? "";
    const inheritedPathIsUsable = existingPath.trim().length > 0;
    const localBin = pathJoin(homedir(), ".local", "bin");
    if (localBin.length > 0 && !existingPath.split(pathDelimiter).includes(localBin)) {
      const augmentedPath =
        existingPath.length > 0 ? `${localBin}${pathDelimiter}${existingPath}` : localBin;
      output[pathKey] = augmentedPath;
      if (pathKey === "Path") {
        output.PATH = augmentedPath;
      }
    }
    // The dev runner itself is launched from the user's terminal environment.
    // Tell the child server not to synchronously source the login shell again:
    // that duplicate probe can block listening for the full timeout when a
    // shell plugin hangs. An empty inherited PATH remains unmarked so the
    // server still performs its normal recovery.
    applyShellEnvironmentHydrationMarker(output, inheritedPathIsUsable);

    if (authToken !== undefined) {
      output.SYNARA_AUTH_TOKEN = authToken;
    } else {
      delete output.SYNARA_AUTH_TOKEN;
    }

    if (noBrowser !== undefined) {
      output.SYNARA_NO_BROWSER = noBrowser ? "1" : "0";
    } else {
      delete output.SYNARA_NO_BROWSER;
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.SYNARA_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.SYNARA_LOG_WS_EVENTS;
    }

    if (mode === "dev") {
      output.SYNARA_MODE = "web";
      delete output.SYNARA_DESKTOP_WS_URL;
    }

    if (mode === "dev:server" || mode === "dev:web") {
      output.SYNARA_MODE = "web";
      delete output.SYNARA_DESKTOP_WS_URL;
    }

    return output;
  });
}

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

const defaultCheckPortAvailability: PortAvailabilityCheck<NetService> = (port) =>
  Effect.gen(function* () {
    const net = yield* NetService;
    return yield* net.isPortAvailableOnLoopback(port);
  });

interface FindFirstAvailableOffsetInput<R = NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) {
        checks.push(checkPort(serverPort));
      }
      if (requireWebPort) {
        checks.push(checkPort(webPort));
      }

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerError({
      message: `No available dev ports found from offset ${startOffset}. Tried server=${BASE_SERVER_PORT}+n web=${BASE_WEB_PORT}+n up to port ${MAX_PORT}.`,
    });
  });
}

interface ResolveModePortOffsetsInput<R = NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: startOffset, webOffset };
    }

    if (mode === "dev:server") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly synaraHome: string | undefined;
  readonly authToken: string | undefined;
  readonly noBrowser: BooleanFlagInput;
  readonly autoBootstrapProjectFromCwd: BooleanFlagInput;
  readonly logWebSocketEvents: BooleanFlagInput;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly turboArgs: ReadonlyArray<string>;
}

interface DevRunnerBooleanEnv {
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
}

export function resolveDevRunnerBooleanOverrides(
  input: Pick<
    DevRunnerCliInput,
    "noBrowser" | "autoBootstrapProjectFromCwd" | "logWebSocketEvents"
  >,
  environment: DevRunnerBooleanEnv,
): DevRunnerBooleanEnv {
  return {
    noBrowser: getBooleanFlagValue(input.noBrowser) ?? environment.noBrowser,
    autoBootstrapProjectFromCwd:
      getBooleanFlagValue(input.autoBootstrapProjectFromCwd) ??
      environment.autoBootstrapProjectFromCwd,
    logWebSocketEvents:
      getBooleanFlagValue(input.logWebSocketEvents) ?? environment.logWebSocketEvents,
  };
}

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const { portOffset, devInstance } = yield* OffsetConfig.asEffect().pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerError({
            message: "Failed to read SYNARA_PORT_OFFSET/SYNARA_DEV_INSTANCE configuration.",
            cause,
          }),
      ),
    );

    const { offset, source } = yield* Effect.try({
      try: () => resolveOffset({ portOffset, devInstance }),
      catch: (cause) =>
        new DevRunnerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    const envOverrides = yield* readDevRunnerBooleanEnvironment(process.env);

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
    });
    const booleanOverrides = resolveDevRunnerBooleanOverrides(input, envOverrides);

    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: process.env,
      serverOffset,
      webOffset,
      synaraHome: input.synaraHome,
      authToken: input.authToken,
      noBrowser: booleanOverrides.noBrowser,
      autoBootstrapProjectFromCwd: booleanOverrides.autoBootstrapProjectFromCwd,
      logWebSocketEvents: booleanOverrides.logWebSocketEvents,
      host: input.host,
      port: input.port,
      devUrl: input.devUrl,
    });

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.SYNARA_PORT)} webPort=${String(env.PORT)} baseDir=${String(env.SYNARA_HOME)}`,
    );

    if (input.dryRun) {
      return;
    }

    const child = yield* ChildProcess.make(
      "turbo",
      [...MODE_ARGS[input.mode], ...input.turboArgs],
      {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
        extendEnv: false,
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
        // Keep turbo in the same process group so terminal signals (Ctrl+C)
        // reach it directly. Effect defaults to detached: true on non-Windows,
        // which would put turbo in a new group and require manual forwarding.
        detached: false,
        forceKillAfter: "1500 millis",
      },
    );

    const exitCode = yield* child.exitCode;
    if (exitCode !== 0) {
      return yield* new DevRunnerError({
        message: `turbo exited with code ${exitCode}`,
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DevRunnerError
        ? cause
        : new DevRunnerError({
            message: cause instanceof Error ? cause.message : "dev-runner failed",
            cause,
          }),
    ),
  );
}

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  synaraHome: Flag.string("home-dir").pipe(
    Flag.withDescription("Base directory for all Synara data (equivalent to SYNARA_HOME)."),
    Flag.withFallbackConfig(HomeConfig),
  ),
  authToken: Flag.string("auth-token").pipe(
    Flag.withDescription("Auth token (forwards to SYNARA_AUTH_TOKEN)."),
    Flag.withAlias("token"),
    Flag.withFallbackConfig(optionalStringConfig("SYNARA_AUTH_TOKEN")),
  ),
  noBrowser: optionalBooleanFlag("no-browser", {
    description: "Disable browser auto-open (equivalent to SYNARA_NO_BROWSER).",
    negativeName: "browser",
    negativeDescription: "Enable browser auto-open.",
  }),
  autoBootstrapProjectFromCwd: optionalBooleanFlag("auto-bootstrap-project-from-cwd", {
    description:
      "Enable project auto-bootstrap (equivalent to SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
  }),
  logWebSocketEvents: optionalBooleanFlag("log-websocket-events", {
    description: "Enable WebSocket event logging (equivalent to SYNARA_LOG_WS_EVENTS).",
    aliases: ["log-ws-events"],
  }),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to SYNARA_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("SYNARA_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to SYNARA_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("SYNARA_PORT")),
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription("Web dev URL override (forwards to VITE_DEV_SERVER_URL)."),
    Flag.withFallbackConfig(optionalUrlConfig("VITE_DEV_SERVER_URL")),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn turbo."),
    Flag.withDefault(false),
  ),
  turboArgs: Argument.string("turbo-arg").pipe(
    Argument.withDescription("Additional turbo args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

const runtimeProgram = Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(cliRuntimeLayer),
);

if (import.meta.main) {
  NodeRuntime.runMain(runtimeProgram);
}
