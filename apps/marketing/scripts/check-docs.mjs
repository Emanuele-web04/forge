import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_ROOT = path.join(ROOT, "content", "docs");

const PAIRED_MDX_COMPONENTS = [
  "Steps",
  "Step",
  "Callout",
  "Cards",
  "Tabs",
  "Tab",
  "Accordions",
  "Accordion",
];

const REQUIRED_GETTING_STARTED_PAGES = [
  "quickstart",
  "core-concepts",
  "installation",
  "providers",
  "first-task",
];

const STATIC_SITE_ROUTES = new Set(["/", "/install", "/privacy", "/changelog", "/docs"]);

function walkFiles(directory, predicate) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...walkFiles(absolute, predicate));
    } else if (predicate(absolute)) {
      files.push(absolute);
    }
  }
  return files;
}

export function parseFrontmatter(source) {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { error: "file must begin with a frontmatter block" };
  }

  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { error: "frontmatter block is not closed" };
  }

  const raw = normalized.slice(4, end);
  const values = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    values[key] = value.replace(
      /^(?:"(.*)"|'(.*)')$/,
      (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted,
    );
  }

  return { values, body: normalized.slice(end + 5) };
}

export function findUnbalancedCodeFences(source) {
  const count = source
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => /^\s*```/.test(line)).length;
  return count % 2 === 0 ? [] : ["code fences are unbalanced"];
}

export function findUnbalancedMdxComponents(source) {
  const errors = [];
  for (const component of PAIRED_MDX_COMPONENTS) {
    const openings = source.match(new RegExp(`<${component}(?:\\s|>)`, "g"))?.length ?? 0;
    const closings = source.match(new RegExp(`</${component}>`, "g"))?.length ?? 0;
    if (openings !== closings) {
      errors.push(`${component} has ${openings} opening tag(s) and ${closings} closing tag(s)`);
    }
  }
  return errors;
}

function routeForDocFile(file) {
  let relative = path
    .relative(DOCS_ROOT, file)
    .replaceAll(path.sep, "/")
    .replace(/\.mdx$/, "");
  if (relative === "index") return "/docs";
  relative = relative.replace(/\/index$/, "");
  return `/docs/${relative}`;
}

function normalizeInternalRoute(target) {
  const withoutQueryOrHash = target.split(/[?#]/, 1)[0] || "/";
  if (withoutQueryOrHash.length > 1) return withoutQueryOrHash.replace(/\/$/, "");
  return withoutQueryOrHash;
}

export function extractInternalLinks(source) {
  const links = new Set();
  const patterns = [
    /\]\((\/[\w./-]*(?:[?#][^\s)]*)?)\)/g,
    /\bhref=["'](\/[\w./-]*(?:[?#][^"']*)?)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) links.add(match[1]);
  }
  return [...links];
}

function validateMetaFile(file) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return [`${path.relative(ROOT, file)}: invalid JSON (${error.message})`];
  }

  if (!Array.isArray(parsed.pages)) return errors;
  const directory = path.dirname(file);
  for (const entry of parsed.pages) {
    if (typeof entry !== "string" || /^---.*---$/.test(entry)) continue;
    const mdx = path.join(directory, `${entry}.mdx`);
    const childDirectory = path.join(directory, entry);
    if (!existsSync(mdx) && !existsSync(childDirectory)) {
      errors.push(
        `${path.relative(ROOT, file)}: pages entry "${entry}" has no matching MDX file or directory`,
      );
    }
  }
  return errors;
}

function validateGettingStartedContract() {
  const errors = [];
  const directory = path.join(DOCS_ROOT, "getting-started");
  const metaPath = path.join(directory, "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));

  if (JSON.stringify(meta.pages) !== JSON.stringify(REQUIRED_GETTING_STARTED_PAGES)) {
    errors.push(
      `content/docs/getting-started/meta.json: expected pages ${JSON.stringify(REQUIRED_GETTING_STARTED_PAGES)}, received ${JSON.stringify(meta.pages)}`,
    );
  }

  for (const page of REQUIRED_GETTING_STARTED_PAGES) {
    if (!existsSync(path.join(directory, `${page}.mdx`))) {
      errors.push(
        `content/docs/getting-started/${page}.mdx: required Getting Started page is missing`,
      );
    }
  }
  return errors;
}

export function collectDocumentationErrors() {
  const errors = [];
  const docs = walkFiles(DOCS_ROOT, (file) => file.endsWith(".mdx"));
  const docRoutes = new Set(docs.map(routeForDocFile));

  for (const file of docs) {
    const relative = path.relative(ROOT, file);
    const source = readFileSync(file, "utf8");
    const frontmatter = parseFrontmatter(source);

    if (frontmatter.error) {
      errors.push(`${relative}: ${frontmatter.error}`);
      continue;
    }

    for (const field of ["title", "description"]) {
      if (
        typeof frontmatter.values[field] !== "string" ||
        frontmatter.values[field].trim() === ""
      ) {
        errors.push(`${relative}: frontmatter field "${field}" is required`);
      }
    }

    for (const error of findUnbalancedCodeFences(source)) errors.push(`${relative}: ${error}`);
    for (const error of findUnbalancedMdxComponents(source)) errors.push(`${relative}: ${error}`);

    for (const rawTarget of extractInternalLinks(source)) {
      const target = normalizeInternalRoute(rawTarget);
      if (target.startsWith("/docs") && !docRoutes.has(target)) {
        errors.push(`${relative}: internal documentation link does not resolve: ${rawTarget}`);
      } else if (
        !target.startsWith("/docs") &&
        !STATIC_SITE_ROUTES.has(target) &&
        !target.startsWith("/changelog/")
      ) {
        errors.push(`${relative}: internal site link is not in the known route set: ${rawTarget}`);
      }
    }
  }

  for (const meta of walkFiles(DOCS_ROOT, (file) => path.basename(file) === "meta.json")) {
    errors.push(...validateMetaFile(meta));
  }

  errors.push(...validateGettingStartedContract());
  return errors;
}

export function main() {
  const errors = collectDocumentationErrors();
  if (errors.length > 0) {
    console.error("Documentation integrity check failed:\n");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("Documentation integrity check passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
