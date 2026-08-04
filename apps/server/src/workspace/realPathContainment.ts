import * as fs from "node:fs/promises";
import * as path from "node:path";

export function isContainedPath(realRoot: string, candidatePath: string): boolean {
  const relativePath = path.relative(realRoot, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function isFileNotFoundError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function isAlreadyExistsError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "EEXIST";
}

function isLexicallyContainedPath(workspaceRoot: string, absolutePath: string): boolean {
  return isContainedPath(path.resolve(workspaceRoot), path.resolve(absolutePath));
}

// String-level containment checks (path.resolve + path.relative) cannot see
// symlinks, so a link inside the workspace pointing outside it would pass and
// the subsequent open/readdir would follow it. Resolve both sides through the
// filesystem and re-check containment on the canonical paths. This also
// canonicalizes roots that are themselves behind symlinks (e.g. /tmp ->
// /private/tmp on macOS), so in-root symlinks keep working.
export async function resolveRealPathWithinRoot(
  workspaceRoot: string,
  absolutePath: string,
): Promise<string | null> {
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(absolutePath),
  ]);
  return isContainedPath(realRoot, realTarget) ? realTarget : null;
}

// Canonicalize the existing prefix of a write/create target, then append only
// the suffix that does not exist yet. Walking one component at a time matters:
// a simple realpath(dirname(target)) cannot validate nested paths whose parent
// directories also need to be created. Existing in-root symlinks remain
// supported, while dangling symlinks and links outside the root are rejected.
export async function resolveRealPathForCreateWithinRoot(
  workspaceRoot: string,
  absolutePath: string,
): Promise<string | null> {
  if (!isLexicallyContainedPath(workspaceRoot, absolutePath)) {
    return null;
  }

  const lexicalRoot = path.resolve(workspaceRoot);
  const lexicalTarget = path.resolve(absolutePath);
  const realRoot = await fs.realpath(lexicalRoot);
  const relativeTarget = path.relative(lexicalRoot, lexicalTarget);
  const components = relativeTarget === "" ? [] : relativeTarget.split(path.sep);
  let currentPath = realRoot;

  for (let index = 0; index < components.length; index += 1) {
    const candidatePath = path.join(currentPath, components[index]!);
    try {
      const realCandidate = await fs.realpath(candidatePath);
      if (!isContainedPath(realRoot, realCandidate)) {
        return null;
      }
      currentPath = realCandidate;
    } catch (cause) {
      if (!isFileNotFoundError(cause)) {
        throw cause;
      }

      // realpath also reports ENOENT for a dangling symlink. Do not classify
      // that as a safe missing component because later filesystem calls may
      // follow it if its external target appears between validation and use.
      let candidateExists = true;
      try {
        await fs.lstat(candidatePath);
      } catch (lstatCause) {
        if (!isFileNotFoundError(lstatCause)) throw lstatCause;
        candidateExists = false;
      }
      if (candidateExists) throw cause;

      const unresolvedPath = path.join(currentPath, ...components.slice(index));
      return isContainedPath(realRoot, unresolvedPath) ? unresolvedPath : null;
    }
  }

  return currentPath;
}

// Prepare a canonical write target while creating missing parent directories.
// Each parent is created and canonicalized separately, so mkdir never receives
// an unresolved multi-component suffix that could traverse an existing link.
export async function prepareRealPathForWriteWithinRoot(
  workspaceRoot: string,
  absolutePath: string,
): Promise<string | null> {
  if (!isLexicallyContainedPath(workspaceRoot, absolutePath)) {
    return null;
  }

  const lexicalRoot = path.resolve(workspaceRoot);
  const lexicalTarget = path.resolve(absolutePath);
  const realRoot = await fs.realpath(lexicalRoot);
  const relativeTarget = path.relative(lexicalRoot, lexicalTarget);
  const components = relativeTarget === "" ? [] : relativeTarget.split(path.sep);
  const targetName = components.pop();
  let currentPath = realRoot;

  for (const component of components) {
    const candidatePath = path.join(currentPath, component);
    let realCandidate: string;
    try {
      realCandidate = await fs.realpath(candidatePath);
    } catch (cause) {
      if (!isFileNotFoundError(cause)) {
        throw cause;
      }

      let candidateExists = true;
      try {
        await fs.lstat(candidatePath);
      } catch (lstatCause) {
        if (isFileNotFoundError(lstatCause)) {
          candidateExists = false;
        } else {
          throw lstatCause;
        }
      }
      if (candidateExists) {
        throw cause;
      }

      try {
        await fs.mkdir(candidatePath);
      } catch (mkdirCause) {
        // A concurrent creator is accepted only after canonical validation.
        if (!isAlreadyExistsError(mkdirCause)) {
          throw mkdirCause;
        }
      }
      realCandidate = await fs.realpath(candidatePath);
    }

    if (!isContainedPath(realRoot, realCandidate)) {
      return null;
    }
    if (!(await fs.stat(realCandidate)).isDirectory()) {
      throw new Error(`Workspace write parent is not a directory: ${candidatePath}`);
    }
    currentPath = realCandidate;
  }

  if (targetName === undefined) {
    return currentPath;
  }
  return resolveRealPathForCreateWithinRoot(realRoot, path.join(currentPath, targetName));
}
