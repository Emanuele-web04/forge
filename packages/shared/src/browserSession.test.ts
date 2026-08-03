import { describe, expect, it } from "vitest";

import {
  BROWSER_SEARCH_URL_PREFIX,
  buildAcceptLanguageHeader,
  buildChromeClientHints,
  chromeMajorVersionFromUserAgent,
  classifyBrowserWindowOpen,
  deriveChromeUserAgent,
  isLikelyOAuthHost,
  normalizeBrowserUrlInput,
  isBlankBrowserTabUrl,
  resolveCopyableBrowserTabUrl,
} from "./browserSession";

const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Synara/0.3.1 Chrome/124.0.6367.91 Electron/30.0.1 Safari/537.36";

describe("deriveChromeUserAgent", () => {
  it("strips Electron and app product tokens to leave a vanilla Chrome UA", () => {
    expect(deriveChromeUserAgent(ELECTRON_UA, ["Synara"])).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.91 Safari/537.36",
    );
  });

  it("preserves the platform and Chrome version from the base UA", () => {
    const derived = deriveChromeUserAgent(ELECTRON_UA, ["Synara"]);
    expect(derived).toContain("Chrome/124.0.6367.91");
    expect(derived).not.toMatch(/Electron/i);
    expect(derived).not.toMatch(/Synara/i);
  });
});

describe("chromeMajorVersionFromUserAgent", () => {
  it("extracts the Chrome major version", () => {
    expect(chromeMajorVersionFromUserAgent(ELECTRON_UA)).toBe("124");
  });

  it("returns null when no Chrome token is present", () => {
    expect(chromeMajorVersionFromUserAgent("Mozilla/5.0 (X11; Linux)")).toBeNull();
  });
});

describe("buildChromeClientHints", () => {
  it("builds a Chrome-matching sec-ch-ua brand list per platform", () => {
    const derived = deriveChromeUserAgent(ELECTRON_UA, ["Synara"]);
    expect(buildChromeClientHints(derived, "darwin")).toEqual({
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not=A?Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    });
    expect(buildChromeClientHints(derived, "win32")?.["sec-ch-ua-platform"]).toBe('"Windows"');
    expect(buildChromeClientHints(derived, "linux")?.["sec-ch-ua-platform"]).toBe('"Linux"');
  });

  it("returns null when the Chrome version can't be parsed", () => {
    expect(buildChromeClientHints("Mozilla/5.0", "darwin")).toBeNull();
  });
});

describe("buildAcceptLanguageHeader", () => {
  it("builds a Chrome-style weighted language list", () => {
    expect(buildAcceptLanguageHeader(["en-US", "en", "it"])).toBe("en-US,en;q=0.9,it;q=0.8");
  });

  it("returns null for an empty list", () => {
    expect(buildAcceptLanguageHeader([])).toBeNull();
  });
});

describe("normalizeBrowserUrlInput", () => {
  it("adds https to naked domains", () => {
    expect(normalizeBrowserUrlInput("phodex.app")).toBe("https://phodex.app/");
  });

  it("uses http for local hosts", () => {
    expect(normalizeBrowserUrlInput("localhost:5173")).toBe("http://localhost:5173/");
  });

  it("preserves explicit local file URLs", () => {
    expect(normalizeBrowserUrlInput("file:///Users/example/project/index.html")).toBe(
      "file:///Users/example/project/index.html",
    );
  });

  it("turns spaced text into a search url", () => {
    expect(normalizeBrowserUrlInput("how to bake bread")).toBe(
      `${BROWSER_SEARCH_URL_PREFIX}how%20to%20bake%20bread`,
    );
  });
});

describe("resolveCopyableBrowserTabUrl", () => {
  it("prefers a non-blank live url over cached tab urls", () => {
    expect(
      resolveCopyableBrowserTabUrl(
        { url: "https://current.example/", lastCommittedUrl: "https://committed.example/" },
        "https://live.example/",
      ),
    ).toBe("https://live.example/");
  });

  it("falls back to committed then current urls while ignoring blank placeholders", () => {
    expect(
      resolveCopyableBrowserTabUrl({
        url: "https://current.example/",
        lastCommittedUrl: "about:blank",
      }),
    ).toBe("https://current.example/");
    expect(resolveCopyableBrowserTabUrl({ url: "about:blank", lastCommittedUrl: null })).toBeNull();
  });
});

describe("isBlankBrowserTabUrl", () => {
  it("treats empty and about:blank tab urls as blank", () => {
    expect(isBlankBrowserTabUrl(null)).toBe(true);
    expect(isBlankBrowserTabUrl({ url: "", lastCommittedUrl: null })).toBe(true);
    expect(isBlankBrowserTabUrl({ url: "about:blank", lastCommittedUrl: "" })).toBe(true);
  });

  it("requires both current and committed urls to be blank", () => {
    expect(
      isBlankBrowserTabUrl({
        url: "about:blank",
        lastCommittedUrl: "https://example.com/",
      }),
    ).toBe(false);
    expect(
      isBlankBrowserTabUrl({
        url: "https://example.com/",
        lastCommittedUrl: "about:blank",
      }),
    ).toBe(false);
  });
});

describe("isLikelyOAuthHost", () => {
  it("matches known auth hosts and their subdomains", () => {
    expect(isLikelyOAuthHost("accounts.google.com")).toBe(true);
    expect(isLikelyOAuthHost("appleid.apple.com")).toBe(true);
    expect(isLikelyOAuthHost("login.microsoftonline.com")).toBe(true);
  });

  it("does not match arbitrary hosts", () => {
    expect(isLikelyOAuthHost("example.com")).toBe(false);
    expect(isLikelyOAuthHost("github.com")).toBe(false);
    expect(isLikelyOAuthHost("")).toBe(false);
  });
});

describe("classifyBrowserWindowOpen", () => {
  it("does not treat new-window disposition alone as a popup", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://example.com/article",
        frameName: "",
        features: "",
        disposition: "new-window",
      }),
    ).toBe("tab");
  });

  it("treats window features as a popup signal", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://example.com/oauth",
        frameName: "oauthWindow",
        features: "width=480,height=640",
        disposition: "foreground-tab",
      }),
    ).toBe("popup");
  });

  it("treats known auth hosts opened via _blank as popups", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://accounts.google.com/o/oauth2/auth",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toBe("popup");
  });

  it("treats known OAuth endpoints on multi-purpose hosts as popups", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://github.com/login/oauth/authorize?client_id=abc",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toBe("popup");
  });

  it("treats reserved frame targets case-insensitively", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://example.com/article",
        frameName: "_BLANK",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toBe("tab");
  });

  it("treats blank staging windows as popups so OAuth SDKs can assign the provider URL", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "about:blank",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toBe("popup");
  });

  it("keeps ordinary _blank links to non-auth hosts as tabs", () => {
    expect(
      classifyBrowserWindowOpen({
        url: "https://example.com/article",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toBe("tab");
  });

  it("keeps ordinary _blank links to multi-purpose provider hosts as tabs", () => {
    for (const url of [
      "https://github.com/openai/codex",
      "https://gitlab.com/gitlab-org/gitlab",
      "https://slack.com/help/articles/360017938993",
      "https://facebook.com/openai",
      "https://discord.com/channels/@me",
      "https://linkedin.com/company/openai",
    ]) {
      expect(
        classifyBrowserWindowOpen({
          url,
          frameName: "_blank",
          features: "",
          disposition: "foreground-tab",
        }),
      ).toBe("tab");
    }
  });
});
