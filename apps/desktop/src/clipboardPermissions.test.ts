import { describe, expect, it } from "vitest";
import { isClipboardWritePermission } from "./clipboardPermissions";

const requester = (url = "https://example.com/page", focused = true, destroyed = false) => ({
  getURL: () => url,
  isFocused: () => focused,
  isDestroyed: () => destroyed,
});
describe("clipboard permissions", () => {
  it.each([
    "https://example.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("allows foreground copy buttons on %s", (url) => {
    expect(
      isClipboardWritePermission(
        requester(url),
        "clipboard-sanitized-write",
        { isMainFrame: true, requestingUrl: url, embeddingOrigin: new URL(url).origin },
        url,
      ),
    ).toBe(true);
  });
  it.each(["clipboard-read", "deprecated-sync-clipboard-read", "media", "unknown"])(
    "does not grant %s",
    (permission) => {
      expect(isClipboardWritePermission(requester(), permission, {})).toBe(false);
    },
  );
  it("rejects background, destroyed, insecure and foreign-frame requests", () => {
    for (const source of [
      null,
      requester(undefined, false),
      requester(undefined, true, true),
      requester("http://example.com"),
      requester("file:///tmp/page.html"),
      requester("bad-url"),
    ])
      expect(isClipboardWritePermission(source, "clipboard-sanitized-write", {})).toBe(false);
    for (const details of [
      { isMainFrame: false },
      { embeddingOrigin: "https://other.test" },
      { requestingUrl: "https://other.test" },
      { requestingUrl: "invalid" },
    ])
      expect(isClipboardWritePermission(requester(), "clipboard-sanitized-write", details)).toBe(
        false,
      );
    expect(
      isClipboardWritePermission(
        requester(),
        "clipboard-sanitized-write",
        {},
        "https://other.test",
      ),
    ).toBe(false);
    expect(isClipboardWritePermission(requester(), "clipboard-sanitized-write", {})).toBe(true);
  });
});
