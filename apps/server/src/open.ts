/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { resolveExecutable } from "@synara/shared/executable";
import { spawnProcess } from "@synara/shared/processRuntime";
import { statSync } from "node:fs";
import { dirname, extname } from "node:path";
import pathWin32 from "node:path/win32";

import { EDITORS, type EditorId } from "@synara/contracts";
import { resolveWindowsSystemRoot } from "@synara/shared/platformEnvironment";
import { ServiceMap, Schema, Effect, Layer } from "effect";
import {
  getEditorMacApplications,
  getEditorWindowsStorePackages,
  getEditorWindowsUriScheme,
  resolveAvailableMacApplication,
  resolveWindowsStorePackageInstallLocation,
  type EditorDefinition,
} from "./editorAppDiscovery";

// ==============================
// Definitions
// ==============================

export class OpenError extends Schema.TaggedErrorClass<OpenError>()("OpenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

export interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

function parseTargetPathAndPosition(target: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} | null {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    path: match[1],
    line: match[2],
    column: match[3],
  };
}

function resolveCommandEditorArgs(
  editor: EditorDefinition,
  target: string,
  command?: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return parsedTarget ? ["--goto", target] : [target];
    case "line-column": {
      if (!parsedTarget) {
        return [target];
      }

      const { path, line, column } = parsedTarget;
      return [...(line ? ["--line", line] : []), ...(column ? ["--column", column] : []), path];
    }
    case "terminal-working-directory":
      return resolveTerminalCommandArgs(command ?? editor.commands?.[0] ?? editor.id, target);
  }
}

// Converts the shared launch metadata into `open -a` arguments for macOS-only apps.
function resolveMacApplicationArgs(
  editor: EditorDefinition,
  target: string,
): ReadonlyArray<string> {
  switch (editor.launchStyle) {
    case "terminal-working-directory":
      if (editor.id === "ghostty") {
        return ["--args", `--working-directory=${resolveTerminalWorkingDirectory(target)}`];
      }
      return [resolveTerminalWorkingDirectory(target)];
    case "line-column":
      return ["--args", ...resolveCommandEditorArgs(editor, target)];
    case "direct-path":
    case "goto":
      return [target];
  }
}

function resolveMacOpenArgs(
  editor: EditorDefinition,
  appName: string,
  target: string,
): ReadonlyArray<string> {
  if (editor.id === "ghostty") {
    return ["-a", appName, resolveTerminalWorkingDirectory(target)];
  }

  return ["-a", appName, ...resolveMacApplicationArgs(editor, target)];
}

function resolveAvailableCommand(
  commands: ReadonlyArray<string>,
  options: CommandAvailabilityOptions = {},
): string | null {
  for (const command of commands) {
    if (isCommandAvailable(command, options)) {
      return command;
    }
  }

  return null;
}

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

function shouldRevealInFinder(target: string): boolean {
  try {
    return statSync(target, { throwIfNoEntry: false })?.isDirectory() === false;
  } catch {
    return false;
  }
}

function resolveFileManagerLaunch(target: string, platform: NodeJS.Platform): EditorLaunch {
  const command = fileManagerCommandForPlatform(platform);
  const shouldReveal = platform === "darwin" && shouldRevealInFinder(target);

  return { command, args: shouldReveal ? ["-R", target] : [target] };
}

// Terminal integrations should receive a directory even when the source target is file:line:column.
function resolveTerminalWorkingDirectory(target: string): string {
  const targetPath = parseTargetPathAndPosition(target)?.path ?? target;

  try {
    const stat = statSync(targetPath);
    return stat.isDirectory() ? targetPath : dirname(targetPath);
  } catch {
    return extname(targetPath).length > 0 ? dirname(targetPath) : targetPath;
  }
}

function normalizeCommandName(command: string): string {
  const executableName = command.split(/[\\/]/).pop() ?? command;
  return executableName.toLowerCase().replace(/\.(?:bat|cmd|com|exe)$/i, "");
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

type TerminalArgsBuilder = (workingDirectory: string) => ReadonlyArray<string>;

const DEFAULT_TERMINAL_ARGS: TerminalArgsBuilder = (workingDirectory) => [
  `--working-directory=${workingDirectory}`,
];

const TERMINAL_ARGS_BY_COMMAND: Readonly<Record<string, TerminalArgsBuilder>> = {
  wt: (workingDirectory) => ["-d", workingDirectory],
  cmd: (workingDirectory) => ["/K", "cd", "/d", workingDirectory],
  powershell: (workingDirectory) => [
    "-NoExit",
    "-Command",
    `Set-Location -LiteralPath ${quotePowerShellLiteral(workingDirectory)}`,
  ],
  pwsh: (workingDirectory) => [
    "-NoExit",
    "-Command",
    `Set-Location -LiteralPath ${quotePowerShellLiteral(workingDirectory)}`,
  ],
  konsole: (workingDirectory) => ["--workdir", workingDirectory],
  kitty: (workingDirectory) => ["--directory", workingDirectory],
  wezterm: (workingDirectory) => ["start", "--cwd", workingDirectory],
  ghostty: DEFAULT_TERMINAL_ARGS,
  // Muxy's CLI opens a project from a bare path, matching its `muxy .` flow.
  muxy: (workingDirectory) => [workingDirectory],
  warp: DEFAULT_TERMINAL_ARGS,
};

function resolveTerminalCommandArgs(command: string, target: string): ReadonlyArray<string> {
  const workingDirectory = resolveTerminalWorkingDirectory(target);
  const buildArgs =
    TERMINAL_ARGS_BY_COMMAND[normalizeCommandName(command)] ?? DEFAULT_TERMINAL_ARGS;
  return buildArgs(workingDirectory);
}

function shouldPreferMacApplicationLaunch(
  editor: EditorDefinition,
  platform: NodeJS.Platform,
): boolean {
  return platform === "darwin" && editor.launchStyle === "terminal-working-directory";
}

function shouldUseImplicitMacApplicationFallback(editor: EditorDefinition): boolean {
  return editor.id === "ghostty" || editor.id === "terminal";
}

function resolveFallbackEditorCommand(
  editor: EditorDefinition,
  platform: NodeJS.Platform,
): string | null {
  if (editor.id === "terminal") {
    return platform === "win32" ? "cmd" : "x-terminal-emulator";
  }

  return editor.commands?.[0] ?? null;
}

function encodeWindowsEditorUriPath(targetPath: string): string {
  return targetPath
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");
}

function resolveWindowsEditorUri(scheme: string, target: string): string {
  const parsedTarget = parseTargetPathAndPosition(target);
  const targetPath = parsedTarget?.path ?? target;
  const encodedPath = encodeWindowsEditorUriPath(targetPath);
  // UNC paths normalize to //server/share; adding another slash changes the network path.
  const filePathSeparator = encodedPath.startsWith("//") ? "" : "/";
  const directorySuffix =
    !parsedTarget && statSync(targetPath, { throwIfNoEntry: false })?.isDirectory() === true
      ? "/"
      : "";
  const positionSuffix = parsedTarget?.line
    ? `:${parsedTarget.line}${parsedTarget.column ? `:${parsedTarget.column}` : ""}`
    : "";

  return `${scheme}://file${filePathSeparator}${encodedPath}${directorySuffix}${positionSuffix}`;
}

export function resolveWindowsEditorUriLaunch(
  editor: EditorDefinition,
  target: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): EditorLaunch | null {
  const scheme = getEditorWindowsUriScheme(editor);
  if (platform !== "win32" || !scheme) return null;

  return {
    command: pathWin32.join(resolveWindowsSystemRoot(env), "explorer.exe"),
    args: [resolveWindowsEditorUri(scheme, target)],
  };
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  return resolveExecutable(command, options) !== null;
}

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.commands !== null) {
      if (resolveAvailableCommand(editor.commands, { platform, env }) !== null) {
        available.push(editor.id);
        continue;
      }
    }

    if (resolveAvailableMacApplication(getEditorMacApplications(editor), platform, env) !== null) {
      available.push(editor.id);
      continue;
    }

    if (
      resolveWindowsStorePackageInstallLocation(
        getEditorWindowsStorePackages(editor),
        platform,
        env,
      ) !== null
    ) {
      available.push(editor.id);
      continue;
    }

    if (editor.id === "file-manager") {
      const command = fileManagerCommandForPlatform(platform);
      if (isCommandAvailable(command, { platform, env })) {
        available.push(editor.id);
      }
    }
  }

  return available;
}

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("synara/open") {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fnUntraced(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<EditorLaunch, OpenError> {
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  const preferredMacApplication = shouldPreferMacApplicationLaunch(editorDef, platform)
    ? (resolveAvailableMacApplication(getEditorMacApplications(editorDef), platform, env) ??
      (shouldUseImplicitMacApplicationFallback(editorDef)
        ? (getEditorMacApplications(editorDef)?.[0] ?? null)
        : null))
    : null;
  if (preferredMacApplication) {
    return {
      command: "open",
      args: resolveMacOpenArgs(editorDef, preferredMacApplication, input.cwd),
    };
  }

  if (editorDef.commands) {
    const command = resolveAvailableCommand(editorDef.commands, { platform, env });
    if (command) {
      return {
        command,
        args: resolveCommandEditorArgs(editorDef, input.cwd, command),
      };
    }
  }

  const windowsUriLaunch = resolveWindowsEditorUriLaunch(editorDef, input.cwd, platform, env);
  if (windowsUriLaunch) {
    return windowsUriLaunch;
  }

  const macApplication =
    resolveAvailableMacApplication(getEditorMacApplications(editorDef), platform, env) ??
    (platform === "darwin" ? (getEditorMacApplications(editorDef)?.[0] ?? null) : null);
  if (macApplication) {
    return {
      command: "open",
      args: resolveMacOpenArgs(editorDef, macApplication, input.cwd),
    };
  }

  if (editorDef.commands) {
    const fallbackCommand = resolveFallbackEditorCommand(editorDef, platform);
    if (!fallbackCommand) {
      return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
    }
    return {
      command: fallbackCommand,
      args: resolveCommandEditorArgs(editorDef, input.cwd, fallbackCommand),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  return resolveFileManagerLaunch(input.cwd, platform);
});

function editorLaunchesEqual(left: EditorLaunch, right: EditorLaunch): boolean {
  return left.command === right.command && left.args.join("\0") === right.args.join("\0");
}

function launchDetachedWithEditorFallback(
  input: OpenInEditorInput,
  launch: EditorLaunch,
): Effect.Effect<void, OpenError> {
  return launchDetached(launch).pipe(
    Effect.catch((primaryError) => {
      const editorDef = EDITORS.find((editor) => editor.id === input.editor);
      const fallbackLaunch = editorDef ? resolveWindowsEditorUriLaunch(editorDef, input.cwd) : null;

      if (!fallbackLaunch || editorLaunchesEqual(launch, fallbackLaunch)) {
        return Effect.fail(primaryError);
      }

      return launchDetached(fallbackLaunch);
    }),
  );
}

export const launchDetached = (launch: EditorLaunch) =>
  Effect.gen(function* () {
    if (!isCommandAvailable(launch.command)) {
      return yield* new OpenError({ message: `Editor command not found: ${launch.command}` });
    }

    yield* Effect.callback<void, OpenError>((resume) => {
      let child;
      try {
        child = spawnProcess(launch.command, launch.args, {
          detached: true,
          stdio: "ignore",
          requireExecutable: true,
        });
      } catch (error) {
        return resume(
          Effect.fail(new OpenError({ message: "failed to spawn detached process", cause: error })),
        );
      }

      const handleSpawn = () => {
        child.unref();
        resume(Effect.void);
      };

      child.once("spawn", handleSpawn);
      child.once("error", (cause) =>
        resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
      );
    });
  });

const make = Effect.gen(function* () {
  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) => new OpenError({ message: "failed to load browser opener", cause }),
  });

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) =>
      // The "system-default" pseudo-editor opens the target with the OS default
      // application (Preview for PDFs on macOS, the registered viewer elsewhere).
      // Reuse the already-loaded cross-platform `open` package instead of guessing
      // per-platform launch commands.
      input.editor === "system-default"
        ? Effect.tryPromise({
            try: () => open.default(input.cwd),
            catch: (cause) => new OpenError({ message: "Failed to open with default app", cause }),
          })
        : Effect.flatMap(resolveEditorLaunch(input), (launch) =>
            launchDetachedWithEditorFallback(input, launch),
          ),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
