import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_HTML_PREVIEW_PROTOCOL,
  LocalHtmlPreviewRegistry,
  isLocalFileUrl,
  isLocalHtmlPreviewUrl,
  isSameLocalHtmlPreviewGrant,
} from "./localHtmlPreviewProtocol";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "synara-local-html-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalHtmlPreviewRegistry", () => {
  it("maps a file URL to an opaque preview origin and back", () => {
    const registry = new LocalHtmlPreviewRegistry(() => "preview-token");
    const sourceUrl = "file:///Users/example/My%20Project/index.html?theme=dark#content";

    const runtimeUrl = registry.toRuntimeUrl(sourceUrl);

    expect(runtimeUrl).toBe("synara-local-preview://preview-token/index.html?theme=dark#content");
    expect(registry.toDisplayUrl(runtimeUrl)).toBe(sourceUrl);
    expect(isLocalFileUrl(sourceUrl)).toBe(true);
    expect(isLocalHtmlPreviewUrl(runtimeUrl)).toBe(true);
    expect(isSameLocalHtmlPreviewGrant(runtimeUrl, new URL("styles.css", runtimeUrl).href)).toBe(
      true,
    );
  });

  it("resolves files inside the granted directory", async () => {
    const root = await makeTemporaryDirectory();
    const assets = join(root, "assets");
    await mkdir(assets);
    const indexPath = join(root, "index.html");
    const cssPath = join(assets, "app.css");
    await writeFile(indexPath, "<link rel=stylesheet href=assets/app.css>");
    await writeFile(cssPath, "body { color: tomato; }");
    const registry = new LocalHtmlPreviewRegistry(() => "preview-token");
    const runtimeUrl = registry.toRuntimeUrl(pathToFileURL(indexPath).href);

    await expect(registry.resolveRequestFileUrl(runtimeUrl)).resolves.toBe(
      pathToFileURL(await realpath(indexPath)).href,
    );
    await expect(
      registry.resolveRequestFileUrl(new URL("assets/app.css", runtimeUrl).href),
    ).resolves.toBe(pathToFileURL(await realpath(cssPath)).href);
  });

  it("rejects missing grants, missing files, and symlinks escaping the granted directory", async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const indexPath = join(root, "index.html");
    const secretPath = join(outside, "secret.txt");
    const linkedSecretPath = join(root, "linked-secret.txt");
    await writeFile(indexPath, "Preview");
    await writeFile(secretPath, "secret");
    await symlink(secretPath, linkedSecretPath);
    const registry = new LocalHtmlPreviewRegistry(() => "preview-token");
    const runtimeUrl = registry.toRuntimeUrl(pathToFileURL(indexPath).href);

    await expect(
      registry.resolveRequestFileUrl(`${LOCAL_HTML_PREVIEW_PROTOCOL}//unknown/index.html`),
    ).resolves.toBeNull();
    await expect(
      registry.resolveRequestFileUrl(new URL("missing.css", runtimeUrl).href),
    ).resolves.toBeNull();
    await expect(
      registry.resolveRequestFileUrl(new URL("linked-secret.txt", runtimeUrl).href),
    ).resolves.toBeNull();
  });

  it("does not grant a filesystem root", () => {
    const registry = new LocalHtmlPreviewRegistry(() => "preview-token");
    const rootFileUrl = pathToFileURL(join(parse(process.cwd()).root, "index.html")).href;

    expect(() => registry.toRuntimeUrl(rootFileUrl)).toThrow(/filesystem root/iu);
  });

  it("only accepts HTML entry points", () => {
    const registry = new LocalHtmlPreviewRegistry(() => "preview-token");

    expect(() => registry.toRuntimeUrl("file:///tmp/project/secrets.txt")).toThrow(
      /only local HTML/iu,
    );
  });

  it("does not serve hidden files from the granted directory", async () => {
    const root = await makeTemporaryDirectory();
    const indexPath = join(root, "index.html");
    await writeFile(indexPath, "Preview");
    await writeFile(join(root, ".env"), "TOKEN=secret");
    const registry = new LocalHtmlPreviewRegistry(() => "preview-token");
    const runtimeUrl = registry.toRuntimeUrl(pathToFileURL(indexPath).href);

    await expect(
      registry.resolveRequestFileUrl(new URL(".env", runtimeUrl).href),
    ).resolves.toBeNull();
  });
});
