// FILE: electronUpdaterSecurity.ts
// Purpose: Hardens electron-updater Windows process calls against Node deprecations.
// Layer: Desktop update runtime
// Exports: updater patching, shell-free PowerShell signature verification helpers.

import type { ExecFileException } from "node:child_process";
import * as Path from "node:path";

import {
  matchesDistinguishedName,
  parseDistinguishedName,
} from "@synara/shared/windowsCertificate";
import { execProcessFile, spawnProcessSync } from "@synara/shared/processRuntime";
import { resolveWindowsPowerShellExecutable } from "@synara/shared/platformEnvironment";

export { parseDistinguishedName } from "@synara/shared/windowsCertificate";

type Logger = {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
};

type UpdaterModule = {
  BaseUpdater?: unknown;
};

type UpdaterPrototype = {
  spawnSyncLog?: (cmd: string, args?: string[], env?: Record<string, string>) => string;
  __synaraSpawnSyncLogPatched?: boolean;
};

type UpdaterWithSignatureVerifier = {
  verifyUpdateCodeSignature?: (
    publisherNames: string[],
    unescapedTempUpdateFile: string,
  ) => Promise<string | null>;
};

interface PowerShellExecOptions {
  readonly encoding: "utf8";
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
}

type ExecFileLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: PowerShellExecOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

interface PowerShellRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface PowerShellFailure extends Error {
  readonly stderr?: string;
}

interface SignatureVerifierOptions {
  readonly execFile?: ExecFileLike;
  readonly env?: NodeJS.ProcessEnv;
}

export function buildPowerShellExecutablePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWindowsPowerShellExecutable(env);
}

export function buildPowerShellExecArgs(command: string): string[] {
  const utf8Preamble =
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
    "$OutputEncoding = [System.Text.Encoding]::UTF8;";
  return [
    "-NoProfile",
    "-NonInteractive",
    "-InputFormat",
    "None",
    "-Command",
    `${utf8Preamble} ${command}`,
  ];
}

function buildPowerShellExecOptions(
  timeout: number,
  env: NodeJS.ProcessEnv,
): PowerShellExecOptions {
  return {
    env: { ...env, PSModulePath: "" },
    encoding: "utf8",
    timeout,
  };
}

function runPowerShell(
  command: string,
  timeout: number,
  options: SignatureVerifierOptions,
): Promise<PowerShellRunResult> {
  const env = options.env ?? process.env;
  return new Promise((resolve, reject) => {
    const execFileImpl: ExecFileLike =
      options.execFile ??
      ((file, args, execOptions, callback) => {
        execProcessFile(
          file,
          args,
          { ...execOptions, platform: "win32", requireExecutable: true },
          (error, stdout, stderr) => {
            callback(error, String(stdout), String(stderr));
          },
        );
      });
    execFileImpl(
      buildPowerShellExecutablePath(env),
      buildPowerShellExecArgs(command),
      buildPowerShellExecOptions(timeout, env),
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as PowerShellFailure;
          Object.defineProperty(failure, "stderr", {
            value: stderr,
            enumerable: false,
            configurable: true,
          });
          reject(failure);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function parseSignatureOutput(out: string): Record<string, unknown> {
  const data = JSON.parse(out) as Record<string, unknown>;
  delete data.PrivateKey;
  delete data.IsOSBinary;
  delete data.SignatureType;

  const signerCertificate =
    typeof data.SignerCertificate === "object" && data.SignerCertificate !== null
      ? (data.SignerCertificate as Record<string, unknown>)
      : null;
  if (signerCertificate) {
    delete signerCertificate.Archived;
    delete signerCertificate.Extensions;
    delete signerCertificate.Handle;
    delete signerCertificate.HasPrivateKey;
    delete signerCertificate.SubjectName;
  }

  return data;
}

function handleSignatureError(logger: Logger, error: unknown, stderr: string | null): string {
  const detail =
    error instanceof Error
      ? error.message
      : error != null
        ? String(error)
        : stderr?.trim() || "unknown PowerShell failure";
  const result = `Windows update signature verification could not be completed: ${detail}`;
  logger.warn?.(result);
  return result;
}

export async function verifyWindowsUpdateCodeSignature(
  publisherNames: string[],
  unescapedTempUpdateFile: string,
  logger: Logger = console,
  options: SignatureVerifierOptions = {},
): Promise<string | null> {
  const tempUpdateFile = unescapedTempUpdateFile.replace(/'/g, "''");
  logger.info?.(`Verifying signature ${tempUpdateFile}`);

  let stdout: string;
  try {
    const result = await runPowerShell(
      `Get-AuthenticodeSignature -LiteralPath '${tempUpdateFile}' | ConvertTo-Json -Compress`,
      20 * 1000,
      options,
    );
    if (result.stderr) {
      return handleSignatureError(logger, null, result.stderr);
    }
    stdout = result.stdout;
  } catch (error) {
    return handleSignatureError(
      logger,
      error,
      error instanceof Error ? ((error as PowerShellFailure).stderr ?? null) : null,
    );
  }

  try {
    const data = parseSignatureOutput(stdout);
    if (data.Status === 0) {
      const signerCertificate =
        typeof data.SignerCertificate === "object" && data.SignerCertificate !== null
          ? (data.SignerCertificate as Record<string, unknown>)
          : null;

      const normalizedUpdateFile = Path.win32.normalize(unescapedTempUpdateFile);
      if (typeof data.Path !== "string" || data.Path.length === 0) {
        return handleSignatureError(
          logger,
          new Error("Get-AuthenticodeSignature returned no signed file path"),
          null,
        );
      }

      const normalizedSignaturePath = Path.win32.normalize(data.Path);
      if (normalizedSignaturePath !== normalizedUpdateFile) {
        return handleSignatureError(
          logger,
          new Error(
            `LiteralPath of ${normalizedSignaturePath} is different than ${normalizedUpdateFile}`,
          ),
          null,
        );
      }

      const signerSubject =
        typeof signerCertificate?.Subject === "string" ? signerCertificate.Subject : "";
      for (const name of publisherNames) {
        if (matchesDistinguishedName(name, signerSubject)) {
          return null;
        }
      }
    }

    const result =
      `publisherNames: ${publisherNames.join(" | ")}, raw info: ` +
      JSON.stringify(data, (name, value) => (name === "RawData" ? undefined : value), 2);
    logger.warn?.(
      `Sign verification failed, installer signed with incorrect certificate: ${result}`,
    );
    return result;
  } catch (error) {
    return handleSignatureError(logger, error, null);
  }
}

export function resolveWindowsUpdatePublisherNames(
  feedPublisherNames: ReadonlyArray<string>,
  embeddedPublisherSubjects: ReadonlyArray<string> | null | undefined,
): string[] {
  return (embeddedPublisherSubjects ?? feedPublisherNames)
    .map((name) => name.trim())
    .filter((name) => {
      const dn = parseDistinguishedName(name);
      return dn.has("CN") && dn.size >= 2;
    });
}

export function hardenElectronUpdater(
  updaterModule: UpdaterModule,
  updater: unknown,
  platform: NodeJS.Platform = process.platform,
  embeddedPublisherSubjects?: ReadonlyArray<string> | null,
): void {
  if (platform !== "win32") {
    return;
  }

  const prototype =
    typeof updaterModule.BaseUpdater === "function"
      ? ((updaterModule.BaseUpdater as { prototype?: UpdaterPrototype }).prototype ?? null)
      : null;
  if (prototype && !prototype.__synaraSpawnSyncLogPatched) {
    prototype.spawnSyncLog = function spawnSyncLog(
      this: { _logger?: Logger },
      cmd: string,
      args: string[] = [],
      env: Record<string, string> = {},
    ): string {
      this._logger?.info?.(`Executing: ${cmd} with args: ${args}`);
      const mergedEnv = { ...process.env, ...env };
      const response = spawnProcessSync(cmd, args, {
        env: mergedEnv,
        encoding: "utf8",
        platform: "win32",
      });
      const { error, status, stdout, stderr } = response;
      if (error) {
        this._logger?.error?.(stderr ?? "");
        throw error;
      }
      if (status != null && status !== 0) {
        this._logger?.error?.(stderr ?? "");
        throw new Error(`Command ${cmd} exited with code ${status}`);
      }
      return (stdout ?? "").trim();
    };
    prototype.__synaraSpawnSyncLogPatched = true;
  }

  const nsisUpdater = updater as UpdaterWithSignatureVerifier | null;
  if (nsisUpdater && "verifyUpdateCodeSignature" in nsisUpdater) {
    nsisUpdater.verifyUpdateCodeSignature = (publisherNames, unescapedTempUpdateFile) => {
      const allowedPublisherNames = resolveWindowsUpdatePublisherNames(
        publisherNames,
        embeddedPublisherSubjects,
      );
      if (allowedPublisherNames.length === 0) {
        return Promise.resolve(
          "Windows update signature verification blocked: no valid embedded publisher subject DN.",
        );
      }
      return verifyWindowsUpdateCodeSignature(
        allowedPublisherNames,
        unescapedTempUpdateFile,
        console,
      );
    };
  }
}
