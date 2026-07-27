import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { ServerConfig } from "../config.ts";
import { GitCommandError } from "./Errors.ts";
import { GitCoreLive } from "./Layers/GitCore.ts";
import { GitCore } from "./Services/GitCore.ts";
import { detectPrTemplate } from "./PrTemplateDetection.ts";

const SINGLE_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

const TEMPLATE_DIRECTORIES = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
] as const;

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-pr-template-test-",
});
const PrTemplateDetectionTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, PrTemplateDetectionTestLayer);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const gitCore = yield* GitCore;
    return yield* gitCore.execute({
      operation: "PrTemplateDetection.test.runGit",
      cwd,
      args,
    });
  });

const runWithTempDirectory = <A, E, R>(
  test: (cwd: string) => Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path | GitCore>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-pr-template-" });
      yield* runGit(cwd, ["init", "--initial-branch=main"]);
      yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test User"]);
      return yield* test(cwd);
    }),
  ).pipe(Effect.provide(TestLayer));

const writeTemplate = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const templatePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(templatePath), { recursive: true });
    yield* fileSystem.writeFileString(templatePath, contents);
    return templatePath;
  });

const commitTemplates = (cwd: string) =>
  Effect.gen(function* () {
    yield* runGit(cwd, ["add", "-A"]);
    yield* runGit(cwd, ["commit", "--allow-empty", "-m", "Add pull request templates"]);
  });

const detectTemplate = (cwd: string, treeish = "HEAD") =>
  Effect.gen(function* () {
    const gitCore = yield* GitCore;
    return yield* detectPrTemplate(cwd, treeish, gitCore.execute);
  });

it.effect.each(SINGLE_TEMPLATE_PATHS)("recognizes $0", (relativePath) =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, relativePath, `template from ${relativePath}`);
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd);
      assert.strictEqual(Option.getOrUndefined(template), `template from ${relativePath}`);
    }),
  ),
);

it.effect("reads templates from the requested base tree", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, "README.md", "initial\n");
      yield* commitTemplates(cwd);
      yield* runGit(cwd, ["branch", "feature"]);
      yield* writeTemplate(cwd, ".github/pull_request_template.md", "base template");
      yield* commitTemplates(cwd);
      yield* runGit(cwd, ["checkout", "feature"]);

      assert.isTrue(Option.isNone(yield* detectTemplate(cwd)));
      assert.strictEqual(
        Option.getOrUndefined(yield* detectTemplate(cwd, "main")),
        "base template",
      );
    }),
  ),
);

it.effect("uses the first non-empty template in the configured path order", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, ".github/pull_request_template.md", " \n");
      yield* writeTemplate(cwd, ".github/PULL_REQUEST_TEMPLATE.md", "  ## Preferred template  \n");
      yield* writeTemplate(cwd, "pull_request_template.md", "## Later template");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd);
      assert.strictEqual(Option.getOrUndefined(template), "## Preferred template");
    }),
  ),
);

it.effect.each(TEMPLATE_DIRECTORIES)("recognizes the $0 directory", (relativeDirectory) =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, `${relativeDirectory}/template.MD`, "directory template");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd);
      assert.strictEqual(Option.getOrUndefined(template), "directory template");
    }),
  ),
);

it.effect("skips unusable directory entries and uses the one valid template", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const templateDirectory = path.join(cwd, ".github", "PULL_REQUEST_TEMPLATE");
      yield* fileSystem.makeDirectory(path.join(templateDirectory, "b-directory.md"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(templateDirectory, "a-empty.md"), " \n");
      yield* fileSystem.symlink(
        path.join(templateDirectory, "missing.md"),
        path.join(templateDirectory, "c-broken.md"),
      );
      yield* fileSystem.writeFileString(path.join(templateDirectory, "z-valid.md"), "valid");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd);
      assert.strictEqual(Option.getOrUndefined(template), "valid");
    }),
  ),
);

it.effect("does not guess between multiple directory templates", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, ".github/PULL_REQUEST_TEMPLATE/a.md", "first");
      yield* writeTemplate(cwd, ".github/PULL_REQUEST_TEMPLATE/b.md", "second");
      yield* writeTemplate(cwd, "PULL_REQUEST_TEMPLATE/fallback.md", "fallback");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd);
      assert.isTrue(Option.isNone(template));
    }),
  ),
);

it.effect("rejects a committed template symlink escaping the repository", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outsideDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "synara-pr-template-outside-",
      });
      const outsideTemplate = path.join(outsideDirectory, "secret.md");
      yield* fileSystem.writeFileString(outsideTemplate, "LOCAL_SECRET_SENTINEL");
      const escapedTemplatePath = path.join(cwd, ".github", "pull_request_template.md");
      yield* fileSystem.makeDirectory(path.dirname(escapedTemplatePath), { recursive: true });
      yield* fileSystem.symlink(outsideTemplate, escapedTemplatePath);
      yield* writeTemplate(cwd, "pull_request_template.md", "safe template");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd);
      assert.strictEqual(Option.getOrUndefined(template), "safe template");
      assert.notInclude(
        Option.getOrElse(template, () => ""),
        "LOCAL_SECRET_SENTINEL",
      );
    }),
  ),
);

it.effect("reads the committed template when a worktree parent is replaced", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outsideDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "synara-pr-template-outside-",
      });
      const templatePath = yield* writeTemplate(
        cwd,
        ".github/pull_request_template.md",
        "committed template",
      );
      yield* commitTemplates(cwd);
      yield* writeTemplate(outsideDirectory, "pull_request_template.md", "LOCAL_SECRET_SENTINEL");

      const templateDirectory = path.dirname(templatePath);
      yield* fileSystem.rename(templateDirectory, path.join(cwd, ".github-original"));
      yield* fileSystem.symlink(outsideDirectory, templateDirectory);

      const template = yield* detectTemplate(cwd);
      assert.strictEqual(Option.getOrUndefined(template), "committed template");
      assert.notInclude(
        Option.getOrElse(template, () => ""),
        "LOCAL_SECRET_SENTINEL",
      );
    }),
  ),
);

it.effect("bounds template reads and marks truncated content", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      const prefix = "a".repeat(8_000);
      yield* writeTemplate(cwd, ".github/pull_request_template.md", `${prefix}SECRET_SENTINEL`);
      yield* commitTemplates(cwd);

      const template = Option.getOrThrow(yield* detectTemplate(cwd));
      assert.strictEqual(template, `${prefix}\n\n[truncated]`);
      assert.lengthOf(template.match(/\[truncated\]/g) ?? [], 1);
      assert.notInclude(template, "SECRET_SENTINEL");
    }),
  ),
);

it.effect("returns none when git listing fails", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      const failingExecute = () =>
        Effect.fail(
          new GitCommandError({
            operation: "PrTemplateDetection.listTemplates",
            command: "git ls-tree",
            cwd,
            detail: "boom",
          }),
        );

      const template = yield* detectPrTemplate(cwd, "HEAD", failingExecute);
      assert.isTrue(Option.isNone(template));
    }),
  ),
);
