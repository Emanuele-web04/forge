import assert from "node:assert/strict";
import test from "node:test";

import {
  collectDocumentationErrors,
  extractInternalLinks,
  findUnbalancedCodeFences,
  findUnbalancedMdxComponents,
  parseFrontmatter,
} from "./check-docs.mjs";

test("parseFrontmatter reads required metadata", () => {
  const result = parseFrontmatter(
    `---\ntitle: Example\ndescription: A useful page.\n---\n\nBody\n`,
  );
  assert.deepEqual(result.values, {
    title: "Example",
    description: "A useful page.",
  });
  assert.match(result.body, /Body/);
});

test("parseFrontmatter rejects missing delimiters", () => {
  assert.deepEqual(parseFrontmatter("# Missing frontmatter"), {
    error: "file must begin with a frontmatter block",
  });
  assert.deepEqual(parseFrontmatter("---\ntitle: Open only"), {
    error: "frontmatter block is not closed",
  });
});

test("extractInternalLinks finds Markdown and MDX links", () => {
  assert.deepEqual(
    extractInternalLinks(
      `[Quickstart](/docs/getting-started/quickstart)\n<Card href="/docs/workflows/worktrees" />`,
    ),
    ["/docs/getting-started/quickstart", "/docs/workflows/worktrees"],
  );
});

test("code fence validation detects unmatched fences", () => {
  assert.deepEqual(findUnbalancedCodeFences("```bash\necho ok\n```"), []);
  assert.deepEqual(findUnbalancedCodeFences("```bash\necho broken"), [
    "code fences are unbalanced",
  ]);
});

test("MDX component validation detects unmatched paired tags", () => {
  assert.deepEqual(findUnbalancedMdxComponents("<Steps><Step>Body</Step></Steps>"), []);
  assert.deepEqual(findUnbalancedMdxComponents("<Steps><Step>Body</Steps>"), [
    "Step has 1 opening tag(s) and 0 closing tag(s)",
  ]);
});

test("the checked-in documentation satisfies every integrity rule", () => {
  assert.deepEqual(collectDocumentationErrors(), []);
});
