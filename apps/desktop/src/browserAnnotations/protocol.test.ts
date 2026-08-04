import {
  BROWSER_ANNOTATION_MAX_COMMENT_LENGTH,
  BROWSER_ANNOTATION_MAX_NAME_LENGTH,
  BROWSER_ANNOTATION_MAX_PAGE_TITLE_LENGTH,
  BROWSER_ANNOTATION_MAX_ROLE_LENGTH,
  BROWSER_ANNOTATION_MAX_SELECTOR_LENGTH,
  BROWSER_ANNOTATION_MAX_TAG_NAME_LENGTH,
  BROWSER_ANNOTATION_MAX_TEXT_LENGTH,
  BROWSER_ANNOTATION_MAX_URL_LENGTH,
  type BrowserAnnotationTheme,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { createGuestIdentifier } from "./guestIdentity";
import {
  parseAnnotationGuestMessage,
  parseBrowserAnnotationTheme,
  parseBrowserAnnotationMarkers,
} from "./protocol";
import { hardenBrowserAnnotationWebviewPreferences } from "./webviewSecurity";
import {
  GUEST_ANNOTATION_MAX_COMMENT_LENGTH,
  GUEST_ANNOTATION_MAX_NAME_LENGTH,
  GUEST_ANNOTATION_MAX_PAGE_TITLE_LENGTH,
  GUEST_ANNOTATION_MAX_ROLE_LENGTH,
  GUEST_ANNOTATION_MAX_SELECTOR_LENGTH,
  GUEST_ANNOTATION_MAX_TAG_NAME_LENGTH,
  GUEST_ANNOTATION_MAX_TEXT_LENGTH,
  GUEST_ANNOTATION_MAX_URL_LENGTH,
  isGuestAnnotationCommand,
} from "./guestProtocol";

const source = { url: "https://example.test/page", pageTitle: "Example" };
const fingerprint = "fnv1a64:0123456789abcdef";
const documentKey = `sha256:${"0".repeat(64)}`;
const theme: BrowserAnnotationTheme = {
  mode: "dark",
  accent: "rgb(96, 115, 204)",
  surface: "rgb(27, 27, 29)",
  text: "rgb(250, 250, 250)",
  mutedText: "rgb(161, 161, 170)",
  border: "rgb(63, 63, 70)",
  focusBorder: "rgb(96, 115, 204)",
  primary: "rgb(250, 250, 250)",
  primaryText: "rgb(24, 24, 27)",
};

describe("browser annotation protocol", () => {
  it("accepts only bounded resolved colors for the guest annotation theme", () => {
    expect(parseBrowserAnnotationTheme(theme)).toEqual(theme);
    expect(
      parseBrowserAnnotationTheme({
        ...theme,
        accent: "oklab(0.62 -0.02 -0.08)",
        surface: "color(srgb 0.75 0.75 0.75)",
      }),
    ).toMatchObject({
      accent: "oklab(0.62 -0.02 -0.08)",
      surface: "color(srgb 0.75 0.75 0.75)",
    });
    expect(
      isGuestAnnotationCommand({
        version: 1,
        kind: "start",
        documentToken: "document-1",
        sessionId: "session-1",
        theme,
      }),
    ).toBe(true);
    expect(
      parseBrowserAnnotationTheme({
        ...theme,
        surface: "url(https://attacker.test/theme.png)",
      }),
    ).toBeNull();
    expect(
      isGuestAnnotationCommand({
        version: 1,
        kind: "start",
        documentToken: "document-1",
        sessionId: "session-1",
        theme: { ...theme, primary: "var(--primary)" },
      }),
    ).toBe(false);
  });

  it("normalizes an empty optional comment to null without exposing form text", () => {
    const parsed = parseAnnotationGuestMessage({
      version: 1,
      kind: "committed",
      documentToken: "document-1",
      sessionId: "session-1",
      annotation: {
        id: "annotation-1",
        source,
        selector: "#email",
        tagName: "input",
        role: "textbox",
        name: "private@example.test",
        text: "private@example.test",
        fingerprint,
        comment: "   ",
        capturedAt: "2026-07-23T10:00:00.000Z",
      },
    });

    expect(parsed?.kind).toBe("committed");
    if (parsed?.kind !== "committed") throw new Error("Expected a committed message.");
    expect(parsed.annotation.comment).toBeNull();
    expect(parsed.annotation.name).toBeNull();
    expect(parsed.annotation.text).toBeNull();
  });

  it("keeps a safe form-control label while still redacting its value text", () => {
    const parsed = parseAnnotationGuestMessage({
      version: 1,
      kind: "committed",
      documentToken: "document-1",
      sessionId: "session-1",
      annotation: {
        id: "annotation-1",
        source,
        selector: "#email",
        tagName: "input",
        role: "textbox",
        name: "Email address",
        text: "private@example.test",
        fingerprint,
        comment: null,
        capturedAt: "2026-07-23T10:00:00.000Z",
      },
    });

    expect(parsed?.kind).toBe("committed");
    if (parsed?.kind !== "committed") throw new Error("Expected a committed message.");
    expect(parsed.annotation.name).toBe("Email address");
    expect(parsed.annotation.text).toBeNull();
  });

  it("removes sensitive page titles at the trusted guest-message boundary", () => {
    const sensitive = parseAnnotationGuestMessage({
      version: 1,
      kind: "ready",
      documentToken: "document-1",
      source: {
        url: "https://example.test/account",
        pageTitle: "Account for private@example.test",
      },
    });
    const ordinary = parseAnnotationGuestMessage({
      version: 1,
      kind: "ready",
      documentToken: "document-2",
      source: {
        url: "https://example.test/docs",
        pageTitle: "React 19 documentation",
      },
    });

    expect(sensitive).toMatchObject({ source: { pageTitle: "" } });
    expect(ordinary).toMatchObject({ source: { pageTitle: "React 19 documentation" } });
  });

  it("rejects oversized, duplicate, and malformed marker projections", () => {
    const marker = {
      id: "annotation-1",
      ordinal: 1,
      documentKey,
      source,
      selector: "#target",
      fingerprint,
    };
    expect(parseBrowserAnnotationMarkers([marker])).toEqual([marker]);
    expect(parseBrowserAnnotationMarkers([{ ...marker, ordinal: 33 }])).not.toBeNull();
    expect(parseBrowserAnnotationMarkers([marker, marker])).toBeNull();
    expect(
      parseBrowserAnnotationMarkers([{ ...marker, selector: `${" ".repeat(1_024)}#target` }]),
    ).toBeNull();
    expect(
      parseBrowserAnnotationMarkers(
        Array.from({ length: 33 }, (_, index) => ({
          ...marker,
          id: `annotation-${index}`,
          ordinal: index + 1,
        })),
      ),
    ).toBeNull();
  });

  it("keeps sandbox-local guest bounds aligned with the public contract", () => {
    expect({
      comment: GUEST_ANNOTATION_MAX_COMMENT_LENGTH,
      name: GUEST_ANNOTATION_MAX_NAME_LENGTH,
      title: GUEST_ANNOTATION_MAX_PAGE_TITLE_LENGTH,
      role: GUEST_ANNOTATION_MAX_ROLE_LENGTH,
      selector: GUEST_ANNOTATION_MAX_SELECTOR_LENGTH,
      tagName: GUEST_ANNOTATION_MAX_TAG_NAME_LENGTH,
      text: GUEST_ANNOTATION_MAX_TEXT_LENGTH,
      url: GUEST_ANNOTATION_MAX_URL_LENGTH,
    }).toEqual({
      comment: BROWSER_ANNOTATION_MAX_COMMENT_LENGTH,
      name: BROWSER_ANNOTATION_MAX_NAME_LENGTH,
      title: BROWSER_ANNOTATION_MAX_PAGE_TITLE_LENGTH,
      role: BROWSER_ANNOTATION_MAX_ROLE_LENGTH,
      selector: BROWSER_ANNOTATION_MAX_SELECTOR_LENGTH,
      tagName: BROWSER_ANNOTATION_MAX_TAG_NAME_LENGTH,
      text: BROWSER_ANNOTATION_MAX_TEXT_LENGTH,
      url: BROWSER_ANNOTATION_MAX_URL_LENGTH,
    });
  });

  it("creates an unpredictable UUID-compatible identifier without randomUUID", () => {
    let next = 0;
    const identifier = createGuestIdentifier({
      getRandomValues: (array) => {
        if (array instanceof Uint8Array) {
          for (let index = 0; index < array.length; index += 1) {
            array[index] = next;
            next += 1;
          }
        }
        return array;
      },
    });
    expect(identifier).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("forces the exact preload and secure guest preferences", () => {
    const webPreferences = {
      preload: "/attacker.js",
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
    };
    expect(
      hardenBrowserAnnotationWebviewPreferences({
        partition: "persist:synara-browser",
        expectedPartition: "persist:synara-browser",
        preloadPath: "/app/browserAnnotations/guestPreload.js",
        webPreferences,
      }),
    ).toBe(true);
    expect(webPreferences).toMatchObject({
      preload: "/app/browserAnnotations/guestPreload.js",
      partition: "persist:synara-browser",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
    expect(
      hardenBrowserAnnotationWebviewPreferences({
        partition: "persist:other",
        expectedPartition: "persist:synara-browser",
        preloadPath: "/app/browserAnnotations/guestPreload.js",
        webPreferences: {},
      }),
    ).toBe(false);
  });
});
