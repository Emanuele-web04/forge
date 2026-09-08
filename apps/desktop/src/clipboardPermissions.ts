import type { WebContents } from "electron";

/** Copy buttons share the OS clipboard; background reads remain denied. */
export function isClipboardWritePermission(
  requester: Pick<WebContents, "isDestroyed" | "isFocused" | "getURL"> | null,
  permission: string,
  details: { isMainFrame?: boolean; requestingUrl?: string; embeddingOrigin?: string },
  requestingOrigin?: string,
): boolean {
  if (
    permission !== "clipboard-sanitized-write" ||
    !requester ||
    requester.isDestroyed() ||
    !requester.isFocused() ||
    details.isMainFrame === false
  )
    return false;
  try {
    const page = new URL(requester.getURL());
    if (
      page.protocol !== "https:" &&
      !(page.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(page.hostname))
    )
      return false;
    return [requestingOrigin, details.requestingUrl, details.embeddingOrigin].every(
      (origin) => !origin || new URL(origin).origin === page.origin,
    );
  } catch {
    return false;
  }
}
