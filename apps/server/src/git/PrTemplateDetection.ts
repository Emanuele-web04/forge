import { Effect, Option } from "effect";

import { GitCommandError } from "./Errors.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "./Services/GitCore.ts";

const TEMPLATE_MAX_BYTES = 8_000;
const BLOB_READ_MAX_BYTES = 100_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TEMPLATE_CANDIDATE_MAX = 16;
const TRUNCATION_MARKER = "[truncated]";

const TEMPLATE_ROOT_DIRECTORIES = [".github", "", "docs"] as const;
const TEMPLATE_DIRECTORY_NAME = "PULL_REQUEST_TEMPLATE";
const TEMPLATE_EXTENSIONS = [".md", ".txt"] as const;

type ExecuteGit = (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;

interface GitTreeEntry {
  readonly mode: string;
  readonly type: "blob" | "tree";
  readonly objectId: string;
  readonly name: string;
}

function parseTreeEntries(output: string): ReadonlyArray<GitTreeEntry> {
  const entries: GitTreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (record.length === 0) {
      continue;
    }

    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }

    const [mode, type, objectId] = record.slice(0, separator).split(" ");
    if (
      !mode ||
      (type !== "blob" && type !== "tree") ||
      !objectId ||
      !/^[0-9a-f]{40,64}$/.test(objectId)
    ) {
      continue;
    }

    entries.push({ mode, type, objectId, name: record.slice(separator + 1) });
  }
  return entries;
}

function isRegularBlob(entry: GitTreeEntry): entry is GitTreeEntry & { readonly type: "blob" } {
  return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}

function findTree(
  entries: ReadonlyArray<GitTreeEntry>,
  name: string,
): (GitTreeEntry & { readonly type: "tree" }) | undefined {
  return entries.find(
    (entry): entry is GitTreeEntry & { readonly type: "tree" } =>
      entry.type === "tree" && entry.mode === "040000" && entry.name === name,
  );
}

function isSingleTemplateName(name: string): boolean {
  const normalized = name.toLowerCase();
  return TEMPLATE_EXTENSIONS.some(
    (extension) => normalized === `pull_request_template${extension}`,
  );
}

function isDirectoryTemplateName(name: string): boolean {
  const normalized = name.toLowerCase();
  return TEMPLATE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

function truncateUtf8(raw: string, maxBytes: number): string {
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return raw;
  }

  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function boundTemplateContents(raw: string): Option.Option<string> {
  if (raw.includes("\0")) {
    return Option.none();
  }
  if (Buffer.byteLength(raw, "utf8") <= TEMPLATE_MAX_BYTES) {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
  }

  const truncated = truncateUtf8(raw, TEMPLATE_MAX_BYTES).trimEnd();
  if (truncated.length === 0) {
    return Option.none();
  }
  return Option.some(`${truncated}\n\n${TRUNCATION_MARKER}`);
}

function resolveTreeId(input: {
  readonly cwd: string;
  readonly treeish: string;
  readonly executeGit: ExecuteGit;
}): Effect.Effect<string, GitCommandError> {
  return input
    .executeGit({
      operation: "PrTemplateDetection.resolveTree",
      cwd: input.cwd,
      args: ["rev-parse", "--verify", "--end-of-options", `${input.treeish}^{tree}`],
      maxOutputBytes: 256,
    })
    .pipe(
      Effect.flatMap((result) => {
        const objectId = result.stdout.trim();
        return /^[0-9a-f]{40,64}$/.test(objectId)
          ? Effect.succeed(objectId)
          : Effect.fail(
              new GitCommandError({
                operation: "PrTemplateDetection.resolveTree",
                command: "git rev-parse",
                cwd: input.cwd,
                detail: "git rev-parse returned an invalid tree object id.",
              }),
            );
      }),
    );
}

function listTreeEntries(input: {
  readonly cwd: string;
  readonly executeGit: ExecuteGit;
  readonly objectId: string;
  readonly operation: string;
}): Effect.Effect<ReadonlyArray<GitTreeEntry>, GitCommandError> {
  return input
    .executeGit({
      operation: input.operation,
      cwd: input.cwd,
      args: ["ls-tree", "-z", input.objectId],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
    })
    .pipe(Effect.map((result) => parseTreeEntries(result.stdout)));
}

function readTemplateBlob(input: {
  readonly cwd: string;
  readonly executeGit: ExecuteGit;
  readonly entry: GitTreeEntry & { readonly type: "blob" };
}): Effect.Effect<Option.Option<string>, GitCommandError> {
  return input
    .executeGit({
      operation: "PrTemplateDetection.readTemplateBlob",
      cwd: input.cwd,
      args: ["cat-file", "blob", input.entry.objectId],
      maxOutputBytes: BLOB_READ_MAX_BYTES,
    })
    .pipe(Effect.map((result) => boundTemplateContents(result.stdout)));
}

type TemplateSelection =
  | { readonly _tag: "None" }
  | { readonly _tag: "Ambiguous" }
  | { readonly _tag: "Template"; readonly value: string };

function selectTemplate(input: {
  readonly cwd: string;
  readonly executeGit: ExecuteGit;
  readonly candidates: ReadonlyArray<GitTreeEntry & { readonly type: "blob" }>;
}): Effect.Effect<TemplateSelection, GitCommandError> {
  return Effect.gen(function* () {
    if (input.candidates.length > TEMPLATE_CANDIDATE_MAX) {
      return { _tag: "Ambiguous" } as const;
    }

    let selectedTemplate: string | undefined;
    for (const entry of input.candidates) {
      const template = yield* readTemplateBlob({ ...input, entry });
      if (Option.isNone(template)) {
        continue;
      }
      if (selectedTemplate !== undefined) {
        return { _tag: "Ambiguous" } as const;
      }
      selectedTemplate = template.value;
    }

    return selectedTemplate === undefined
      ? ({ _tag: "None" } as const)
      : ({ _tag: "Template", value: selectedTemplate } as const);
  });
}

function listChildTree(
  cwd: string,
  executeGit: ExecuteGit,
  entries: ReadonlyArray<GitTreeEntry>,
  name: string,
  operation: string,
): Effect.Effect<ReadonlyArray<GitTreeEntry>, GitCommandError> {
  const tree = findTree(entries, name);
  return tree
    ? listTreeEntries({ cwd, executeGit, objectId: tree.objectId, operation })
    : Effect.succeed([]);
}

export const detectPrTemplate = Effect.fn("detectPrTemplate")(function* (
  cwd: string,
  treeish: string,
  executeGit: ExecuteGit,
) {
  return yield* Effect.gen(function* () {
    // Resolve once and traverse only committed tree objects. No worktree path is opened, so
    // repository-controlled symlinks and worktree path races cannot reach the host filesystem.
    const rootTreeId = yield* resolveTreeId({ cwd, treeish, executeGit });
    const rootEntries = yield* listTreeEntries({
      cwd,
      executeGit,
      objectId: rootTreeId,
      operation: "PrTemplateDetection.listRoot",
    });
    const githubEntries = yield* listChildTree(
      cwd,
      executeGit,
      rootEntries,
      ".github",
      "PrTemplateDetection.listGithub",
    );
    const docsEntries = yield* listChildTree(
      cwd,
      executeGit,
      rootEntries,
      "docs",
      "PrTemplateDetection.listDocs",
    );

    const entriesByRoot = new Map<string, ReadonlyArray<GitTreeEntry>>([
      [".github", githubEntries],
      ["", rootEntries],
      ["docs", docsEntries],
    ]);

    // GitHub checks the supported default-file locations in this order. A default file is
    // automatically applied even when chooser-only templates also exist in a template directory.
    for (const rootDirectory of TEMPLATE_ROOT_DIRECTORIES) {
      const entries = entriesByRoot.get(rootDirectory) ?? [];
      const selection = yield* selectTemplate({
        cwd,
        executeGit,
        candidates: entries.filter(
          (entry): entry is GitTreeEntry & { readonly type: "blob" } =>
            isRegularBlob(entry) && isSingleTemplateName(entry.name),
        ),
      });
      if (selection._tag === "Template") {
        return Option.some(selection.value);
      }
      if (selection._tag === "Ambiguous") {
        return Option.none();
      }
    }

    const directoryCandidates: Array<GitTreeEntry & { readonly type: "blob" }> = [];
    for (const rootDirectory of TEMPLATE_ROOT_DIRECTORIES) {
      const entries = entriesByRoot.get(rootDirectory) ?? [];
      const directoryEntries = yield* listChildTree(
        cwd,
        executeGit,
        entries,
        TEMPLATE_DIRECTORY_NAME,
        `PrTemplateDetection.listDirectory.${rootDirectory || "root"}`,
      );
      directoryCandidates.push(
        ...directoryEntries.filter(
          (entry): entry is GitTreeEntry & { readonly type: "blob" } =>
            isRegularBlob(entry) && isDirectoryTemplateName(entry.name),
        ),
      );
    }

    const directorySelection = yield* selectTemplate({
      cwd,
      executeGit,
      candidates: directoryCandidates,
    });
    return directorySelection._tag === "Template"
      ? Option.some(directorySelection.value)
      : Option.none();
  }).pipe(Effect.orElseSucceed(() => Option.none()));
});
