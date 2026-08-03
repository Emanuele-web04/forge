// FILE: localHtmlPreviewProtocol.ts
// Purpose: Maps explicit local-file navigations onto a scoped custom protocol so HTML previews
//   can load relative assets without granting file:// pages unrestricted filesystem access.
// Layer: Desktop browser infrastructure

import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOCAL_HTML_PREVIEW_SCHEME = "synara-local-preview" as const;
export const LOCAL_HTML_PREVIEW_PROTOCOL = `${LOCAL_HTML_PREVIEW_SCHEME}:` as const;

interface LocalHtmlPreviewGrant {
  readonly token: string;
  readonly rootPath: string;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = Path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!Path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${Path.sep}`))
  );
}

function decodePreviewPath(pathname: string): readonly string[] | null {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      value.length === 0 ||
      value === "." ||
      value === ".." ||
      value.startsWith(".") ||
      value.includes("/") ||
      value.includes("\\") ||
      value.includes("\0")
    ) {
      return null;
    }
    decoded.push(value);
  }
  return decoded;
}

function parseFileUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? url : null;
  } catch {
    return null;
  }
}

function parsePreviewUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== LOCAL_HTML_PREVIEW_PROTOCOL ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.port.length > 0
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function isLocalFileUrl(value: string): boolean {
  return parseFileUrl(value) !== null;
}

export function isLocalHtmlPreviewUrl(value: string): boolean {
  return parsePreviewUrl(value) !== null;
}

export function isSameLocalHtmlPreviewGrant(sourceUrl: string, targetUrl: string): boolean {
  const source = parsePreviewUrl(sourceUrl);
  const target = parsePreviewUrl(targetUrl);
  return source !== null && target !== null && source.hostname === target.hostname;
}

export class LocalHtmlPreviewRegistry {
  private readonly grantsByToken = new Map<string, LocalHtmlPreviewGrant>();
  private readonly grantsByRootPath = new Map<string, LocalHtmlPreviewGrant>();

  constructor(
    private readonly createToken: () => string = () => Crypto.randomBytes(24).toString("hex"),
  ) {}

  toRuntimeUrl(value: string): string {
    const sourceUrl = parseFileUrl(value);
    if (!sourceUrl) {
      return value;
    }

    const sourcePath = fileURLToPath(sourceUrl);
    const extension = Path.extname(sourcePath).toLowerCase();
    if (extension !== ".html" && extension !== ".htm" && extension !== ".xhtml") {
      throw new Error("Only local HTML files can be opened in the browser preview.");
    }
    const rootPath = Path.dirname(sourcePath);
    if (Path.parse(rootPath).root === rootPath) {
      throw new Error("Local HTML files at the filesystem root can't be previewed safely.");
    }

    let grant = this.grantsByRootPath.get(rootPath);
    if (!grant) {
      grant = { token: this.createToken(), rootPath };
      this.grantsByRootPath.set(rootPath, grant);
      this.grantsByToken.set(grant.token, grant);
    }

    const runtimeUrl = new URL(
      `${LOCAL_HTML_PREVIEW_SCHEME}://${grant.token}/${encodeURIComponent(Path.basename(sourcePath))}`,
    );
    runtimeUrl.search = sourceUrl.search;
    runtimeUrl.hash = sourceUrl.hash;
    return runtimeUrl.href;
  }

  toDisplayUrl(value: string): string {
    const resolved = this.resolvePreviewUrl(value);
    return resolved?.href ?? value;
  }

  async resolveRequestFileUrl(value: string): Promise<string | null> {
    const resolved = this.resolvePreviewUrl(value);
    if (!resolved) {
      return null;
    }

    const previewUrl = parsePreviewUrl(value);
    const grant = previewUrl ? this.grantsByToken.get(previewUrl.hostname) : null;
    if (!grant) {
      return null;
    }

    try {
      const [realRootPath, realFilePath] = await Promise.all([
        FS.realpath(grant.rootPath),
        FS.realpath(fileURLToPath(resolved)),
      ]);
      if (!isPathWithinRoot(realRootPath, realFilePath)) {
        return null;
      }
      const stats = await FS.stat(realFilePath);
      if (!stats.isFile()) {
        return null;
      }
      const fileUrl = pathToFileURL(realFilePath);
      fileUrl.search = resolved.search;
      return fileUrl.href;
    } catch {
      return null;
    }
  }

  clear(): void {
    this.grantsByToken.clear();
    this.grantsByRootPath.clear();
  }

  private resolvePreviewUrl(value: string): URL | null {
    const previewUrl = parsePreviewUrl(value);
    if (!previewUrl) {
      return null;
    }
    const grant = this.grantsByToken.get(previewUrl.hostname);
    const segments = decodePreviewPath(previewUrl.pathname);
    if (!grant || !segments || segments.length === 0) {
      return null;
    }

    const fileUrl = pathToFileURL(Path.join(grant.rootPath, ...segments));
    fileUrl.search = previewUrl.search;
    fileUrl.hash = previewUrl.hash;
    return fileUrl;
  }
}
