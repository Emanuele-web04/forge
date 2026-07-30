// FILE: fakeRemoteHost.ts
// Purpose: An in-memory RemoteConnection that models just enough of a POSIX box
//          (mkdir/rm/mv/ln/readlink/tar/sha256sum/cat/chmod) to run the real
//          bootstrap orchestrator against it — including its failure and
//          interruption paths, which is where the interesting bugs are.
// Layer: Server / remote broker test support
// Exports: FakeRemoteHost, createFakeRemoteHost, InterruptionError

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { RemoteConnection, RemoteExecOptions, RemoteExecResult } from "./remoteConnection";

/** Thrown by an injected fault to simulate the connection dropping mid-run. */
export class InterruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterruptionError";
  }
}

interface FakeFile {
  readonly kind: "file";
  contents: string;
  mode: number;
}

interface FakeDirectory {
  readonly kind: "directory";
}

interface FakeSymlink {
  readonly kind: "symlink";
  target: string;
}

type FakeNode = FakeFile | FakeDirectory | FakeSymlink;

export interface FakeRemoteHost {
  readonly connection: RemoteConnection;
  /** Every argv the bootstrapper ran, in order. */
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
  readonly nodes: Map<string, FakeNode>;
  exists(path: string): boolean;
  readFile(path: string): string | null;
  readLink(path: string): string | null;
  listUnder(prefix: string): ReadonlyArray<string>;
  /** Registers a one-shot fault keyed by the first two argv tokens. */
  failOn(match: (argv: ReadonlyArray<string>) => boolean, fault: () => never): void;
  /**
   * Makes every matching command return a canned result instead of running.
   *
   * Distinct from `failOn`, which throws: a real remote command that fails
   * exits non-zero and may still have written to stdout. That combination — a
   * failed digest tool that nonetheless prints a plausible digest line — is the
   * one a caller can most easily mistake for success.
   */
  stubExit(match: (argv: ReadonlyArray<string>) => boolean, result: RemoteExecResult): void;
  /**
   * Registers a fault that fires PART WAY THROUGH a non-atomic command.
   *
   * `ln -sfn` unlinks the old link before creating the new one; a fault in that
   * window is the only way to observe a `current` that points at nothing. An
   * atomic `mv -T` has no such window, which is exactly what the swap must use.
   */
  failMidCommand(match: (argv: ReadonlyArray<string>) => boolean, fault: () => never): void;
  /**
   * Makes the next upload to `remotePath` land different bytes while still
   * reporting success — a lossy link, not a dropped one. This is the only way
   * to exercise the post-upload remote checksum, because a fault that throws
   * would abort before the check runs and would pass even without it.
   */
  corruptNextUpload(remotePath: string, contents: string): void;
  /** Truncates a file to simulate a killed upload. */
  truncate(path: string, keepBytes: number): void;
  /**
   * Registers a running process, so `/proc/<pid>/exe` resolves to
   * `executablePath` the way it does on Linux.
   *
   * Ownership checks read that link, so this is how a test distinguishes our
   * own server from an unrelated process that inherited a recycled pid.
   */
  registerProcess(pid: number, executablePath: string): void;
}

const ok = (stdout = ""): RemoteExecResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string, exitCode = 1): RemoteExecResult => ({ exitCode, stdout: "", stderr });

function parent(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

export function createFakeRemoteHost(): FakeRemoteHost {
  const nodes = new Map<string, FakeNode>([["/", { kind: "directory" }]]);
  const commands: Array<ReadonlyArray<string>> = [];
  const faults: Array<{
    match: (argv: ReadonlyArray<string>) => boolean;
    fault: () => never;
  }> = [];
  const corruptions = new Map<string, string>();
  const stubs: Array<{
    match: (argv: ReadonlyArray<string>) => boolean;
    result: RemoteExecResult;
  }> = [];
  const midCommandFaults: Array<{
    match: (argv: ReadonlyArray<string>) => boolean;
    fault: () => never;
  }> = [];

  const mkdirp = (path: string): void => {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      if (!nodes.has(current)) nodes.set(current, { kind: "directory" });
    }
  };

  /** Keys are snapshotted first: deleting while iterating a Map is undefined. */
  const keysUnder = (path: string): ReadonlyArray<string> =>
    Array.from(nodes.keys(), (key) => key).filter(
      (key) => key === path || key.startsWith(`${path}/`),
    );

  const removeRecursive = (path: string): void => {
    for (const key of keysUnder(path)) nodes.delete(key);
  };

  const resolveLink = (path: string): string | null => {
    const node = nodes.get(path);
    return node?.kind === "symlink" ? node.target : null;
  };

  /** Resolves symlinks in every path component, the way a real kernel does. */
  const resolvePath = (path: string): string => {
    let resolved = "";
    for (const segment of path.split("/").filter(Boolean)) {
      resolved += `/${segment}`;
      for (let hops = 0; hops < 8; hops += 1) {
        const node = nodes.get(resolved);
        if (node?.kind !== "symlink") break;
        resolved = node.target;
      }
    }
    return resolved === "" ? "/" : resolved;
  };

  const readFile = (path: string): string | null => {
    const node = nodes.get(resolvePath(path));
    return node?.kind === "file" ? node.contents : null;
  };

  /**
   * Fires a fault registered for the MIDDLE of a non-atomic command.
   *
   * `ln -sfn` unlinks before it creates; a fault here lands in that window,
   * which is the only way to observe a dangling `current`.
   */
  const runMidCommandFaults = (argv: ReadonlyArray<string>): void => {
    for (const [index, { match, fault }] of midCommandFaults.entries()) {
      if (match(argv)) {
        midCommandFaults.splice(index, 1);
        fault();
      }
    }
  };

  const run = (argv: ReadonlyArray<string>, options?: RemoteExecOptions): RemoteExecResult => {
    commands.push(argv);
    for (const [index, { match, fault }] of faults.entries()) {
      if (match(argv)) {
        faults.splice(index, 1);
        fault();
      }
    }
    for (const { match, result } of stubs) {
      if (match(argv)) return result;
    }
    // Strip a `--` end-of-options separator the way GNU utilities do.
    const [command, ...rest] = argv;
    const args = rest.filter((token) => token !== "--");
    const flags = args.filter((token) => token.startsWith("-"));
    const operands = args.filter((token) => !token.startsWith("-"));
    /** A missing operand is a malformed command, not an empty path. */
    const operand = (index: number): string => {
      const value = operands[index];
      if (value === undefined) throw new Error(`${command}: missing operand ${index}`);
      return value;
    };

    switch (command) {
      case "mkdir": {
        // Without `-p`, mkdir FAILS when the directory exists. That is what
        // makes it usable as an atomic lock, so the fake must model it: a
        // permissive mkdir would let two concurrent bootstraps both "acquire".
        const parents = flags.some((flag) => flag.includes("p"));
        for (const operand of operands) {
          if (!parents && nodes.has(operand)) {
            return fail(`mkdir: cannot create directory '${operand}': File exists`);
          }
        }
        for (const operand of operands) mkdirp(operand);
        return ok();
      }
      case "chmod": {
        const mode = operand(0);
        for (const target of operands.slice(1)) {
          const node = nodes.get(target);
          if (!node) return fail(`chmod: cannot access '${target}'`);
          if (node.kind === "file") node.mode = Number.parseInt(mode, 8);
        }
        return ok();
      }
      case "rm": {
        const force = flags.some((flag) => flag.includes("f"));
        for (const operand of operands) {
          if (!nodes.has(operand) && !force) return fail(`rm: no such file: ${operand}`);
          removeRecursive(operand);
        }
        return ok();
      }
      case "cp": {
        const from = resolvePath(operand(0));
        const to = operand(1);
        const source = nodes.get(from);
        if (!source) return fail(`cp: no such file: ${operand(0)}`);
        if (source.kind !== "file") return fail(`cp: not a regular file: ${operand(0)}`);
        mkdirp(parent(to));
        nodes.set(to, { kind: "file", contents: source.contents, mode: source.mode });
        return ok();
      }
      case "mv": {
        const from = operand(0);
        const to = operand(1);
        if (!nodes.has(from)) return fail(`mv: no such file: ${from}`);
        // `mv -T` is a single rename(2): the destination name never stops
        // existing, it just points somewhere new. No mid-command fault hook
        // here, deliberately — that is the property the swap relies on.
        if (flags.some((flag) => flag.includes("T"))) {
          const source = nodes.get(from);
          if (source?.kind === "symlink") {
            nodes.set(to, { kind: "symlink", target: source.target });
            nodes.delete(from);
            return ok();
          }
        }
        removeRecursive(to);
        for (const key of keysUnder(from)) {
          const node = nodes.get(key);
          if (node) nodes.set(to + key.slice(from.length), node);
          nodes.delete(key);
        }
        return ok();
      }
      case "ln": {
        const target = operand(0);
        const link = operand(1);
        mkdirp(parent(link));
        // `ln -sfn` is NOT atomic: coreutils unlinks the existing link and then
        // creates the new one, so there is a window in which the name does not
        // exist at all. Modelling it as a single map write is what hid the
        // dangling-`current` bug, so the two halves are separated here and a
        // fault can be injected between them.
        const replacing = nodes.has(link);
        if (replacing) nodes.delete(link);
        runMidCommandFaults(argv);
        nodes.set(link, { kind: "symlink", target });
        return ok();
      }
      case "readlink": {
        const target = resolveLink(operand(0));
        return target === null ? fail("readlink: not a symlink") : ok(`${target}\n`);
      }
      case "cat": {
        const contents = readFile(operand(0));
        return contents === null ? fail(`cat: no such file: ${operand(0)}`) : ok(contents);
      }
      case "sha256sum": {
        const contents = readFile(operand(0));
        if (contents === null) return fail(`sha256sum: no such file: ${operand(0)}`);
        const digest = createHash("sha256").update(contents).digest("hex");
        return ok(`${digest}  ${operand(0)}\n`);
      }
      case "shasum": {
        // The fake box is GNU-flavoured; shasum is absent, which exercises the
        // fallback ordering in remoteDigest.
        return fail("shasum: command not found", 127);
      }
      case "tar": {
        const source = operands.find((operand) => operand.endsWith(".tar.gz"));
        const destinationIndex = args.indexOf("-C");
        const destination = destinationIndex >= 0 ? args[destinationIndex + 1] : undefined;
        if (!source || !destination) return fail("tar: bad invocation");
        const contents = readFile(source);
        if (contents === null) return fail(`tar: no such file: ${source}`);
        // The fake tarball's payload is a JSON manifest of path -> contents.
        let manifest: Record<string, string>;
        try {
          manifest = JSON.parse(contents);
        } catch {
          return fail("tar: not a valid archive");
        }
        mkdirp(destination);
        for (const [relative, fileContents] of Object.entries(manifest)) {
          const absolute = `${destination}/${relative}`;
          mkdirp(parent(absolute));
          nodes.set(absolute, { kind: "file", contents: fileContents, mode: 0o644 });
        }
        return ok();
      }
      case "sh": {
        // Only the exact `umask 077; cat > "$1"` form the bootstrapper uses.
        const script = rest[1];
        if (script !== 'umask 077; cat > "$1"') return fail("sh: unsupported script");
        const target = rest[3];
        if (target === undefined) return fail("sh: missing target path");
        mkdirp(parent(target));
        nodes.set(target, { kind: "file", contents: options?.stdin ?? "", mode: 0o600 });
        return ok();
      }
      case "kill":
        return ok();
      case "systemctl":
      case "loginctl":
      case "launchctl":
        return ok();
      default:
        return fail(`${command}: command not found`, 127);
    }
  };

  const connection: RemoteConnection = {
    describe: "fake@host",
    exec(argv, options) {
      return Promise.resolve(run(argv, options));
    },
    uploadFile({ localPath, remotePath, mode }) {
      commands.push(["scp", localPath, remotePath]);
      for (const [index, { match, fault }] of faults.entries()) {
        if (match(["scp", localPath, remotePath])) {
          faults.splice(index, 1);
          fault();
        }
      }
      mkdirp(parent(remotePath));
      const corruption = corruptions.get(remotePath);
      if (corruption !== undefined) corruptions.delete(remotePath);
      nodes.set(remotePath, {
        kind: "file",
        contents: corruption ?? readFileSync(localPath, "utf8"),
        mode: mode ?? 0o600,
      });
      return Promise.resolve();
    },
  };

  return {
    connection,
    commands,
    nodes,
    exists: (path) => nodes.has(path),
    readFile,
    readLink: resolveLink,
    listUnder: (prefix) => [...nodes.keys()].filter((key) => key.startsWith(prefix)).sort(),
    failOn(match, fault) {
      faults.push({ match, fault });
    },
    stubExit(match, result) {
      stubs.push({ match, result });
    },
    failMidCommand(match, fault) {
      midCommandFaults.push({ match, fault });
    },
    corruptNextUpload(remotePath, contents) {
      corruptions.set(remotePath, contents);
    },
    truncate(path, keepBytes) {
      const node = nodes.get(path);
      if (node?.kind === "file") node.contents = node.contents.slice(0, keepBytes);
    },
    registerProcess(pid, executablePath) {
      mkdirp(`/proc/${pid}`);
      nodes.set(`/proc/${pid}/exe`, { kind: "symlink", target: executablePath });
    },
  };
}
