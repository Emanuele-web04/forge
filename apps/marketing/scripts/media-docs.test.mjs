import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = path.join(ROOT, "content/docs");

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = path.join(directory, entry);
    return statSync(fullPath).isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function withoutCodeFences(source) {
  return source.replace(/```[\s\S]*?```/g, "");
}

function componentBlocks(source, component) {
  const expression = new RegExp(`<${component}\\b[\\s\\S]*?\\/>`, "g");
  return source.match(expression) ?? [];
}

test("documentation media primitives enforce local, accessible, stable rendering", () => {
  const media = read("src/components/docs/media.tsx");
  const registry = read("src/components/mdx.tsx");

  for (const component of ["DocsImage", "DocsScreenshot", "DocsGallery", "DocsVideo"]) {
    assert.ok(registry.includes(component), `MDX registry is missing ${component}`);
  }

  assert.ok(media.includes("assertLocalMediaPath"));
  assert.ok(media.includes("positive integer width and height"));
  assert.ok(media.includes("Documentation media requires useful alternative text"));
  assert.ok(media.includes("controls"));
  assert.ok(media.includes('preload="metadata"'));
  assert.ok(media.includes('kind="captions"'));
  assert.ok(media.includes("Video transcript"));
  assert.ok(media.includes('target="_blank"'));
  assert.ok(media.includes('rel="noopener noreferrer"'));
  assert.doesNotMatch(media, /autoPlay|<iframe/i);
});

test("documentation uses controlled media components instead of raw embeds", () => {
  for (const file of walk(CONTENT).filter((candidate) => candidate.endsWith(".mdx"))) {
    const source = withoutCodeFences(readFileSync(file, "utf8"));
    const relative = path.relative(ROOT, file);

    assert.doesNotMatch(
      source,
      /!\[[^\]]*\]\([^)]*\)/,
      `${relative} uses raw Markdown image syntax`,
    );
    assert.doesNotMatch(source, /<(?:img|video|iframe)\b/i, `${relative} uses a raw media element`);

    for (const component of ["DocsImage", "DocsScreenshot"]) {
      for (const block of componentBlocks(source, component)) {
        assert.match(block, /\balt="[^"]+"/, `${relative} ${component} needs alt text`);
        assert.match(block, /\bwidth=\{\d+\}/, `${relative} ${component} needs width`);
        assert.match(block, /\bheight=\{\d+\}/, `${relative} ${component} needs height`);
        assert.match(
          block,
          /\bprovenance="(?:real|derived|diagram)"/,
          `${relative} ${component} needs provenance`,
        );

        for (const match of block.matchAll(/\b(?:src|lightSrc|darkSrc)="([^"]+)"/g)) {
          const asset = match[1];
          assert.ok(
            asset.startsWith("/") && !asset.startsWith("//"),
            `${relative} media must be local`,
          );
          const assetPath = path.join(ROOT, "public", asset);
          assert.ok(existsSync(assetPath), `${relative} references missing ${asset}`);
          if (asset.endsWith(".svg")) {
            const svg = readFileSync(assetPath, "utf8");
            assert.doesNotMatch(
              svg,
              /<script\b|<foreignObject\b|\son[a-z]+=|(?:href|src)=["']https?:/i,
              `${relative} references unsafe SVG ${asset}`,
            );
          }
        }
      }
    }

    for (const block of componentBlocks(source, "DocsVideo")) {
      for (const required of [
        "src",
        "poster",
        "captions",
        "title",
        "transcript",
        "width",
        "height",
      ]) {
        assert.match(
          block,
          new RegExp(`\\b${required}=`),
          `${relative} DocsVideo needs ${required}`,
        );
      }
    }
  }
});

test("media authoring guide defines privacy, provenance, accessibility, and asset policy", () => {
  const guide = read("docs/documentation-media.md");

  for (const phrase of [
    "seeded demonstration workspace",
    "Remove personal thread names",
    "provenance",
    "WebVTT",
    "transcript",
    "Do not commit GIFs",
    "third-party iframe",
    "Width and height match",
    "source app behavior",
  ]) {
    assert.ok(guide.includes(phrase), `media guide is missing: ${phrase}`);
  }
});

test("the initial docs integration is explicitly derived and dimensioned", () => {
  const coreConcepts = read("content/docs/getting-started/core-concepts.mdx");
  const block = componentBlocks(coreConcepts, "DocsScreenshot")[0];

  assert.ok(block);
  assert.match(block, /lightSrc="\/synara-ui-light\.png"/);
  assert.match(block, /darkSrc="\/synara-ui-dark\.png"/);
  assert.match(block, /width=\{3216\}/);
  assert.match(block, /height=\{2090\}/);
  assert.match(block, /provenance="derived"/);
  assert.match(block, /representative composition/i);
});
