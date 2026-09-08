// FILE: localServerMonitor.test.ts
// Purpose: Covers localhost listener parsing, dev-server filtering, and page-title enrichment.
// Layer: Server unit tests for localServerMonitor.ts.
// Depends on: Vitest and exported local server monitor helpers.

import { describe, expect, it, vi } from "vitest";

import {
  buildLocalServerProcesses,
  enrichLocalServerProcessesWithPageTitles,
  excludePortsFromListeners,
  extractLocalServerPageTitle,
  isExcludedFromFullScan,
  isIgnoredLocalServerProcess,
  detectDevServerKindFromText,
  parseProcessInfo,
  parseLsofCwdOutput,
  parseLsofTcpListenOutput,
  resolveOwnListenerPorts,
  type LocalServerProcessInfo,
} from "./localServerMonitor";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

async function withMockedFetch<T>(
  fetchMock: typeof globalThis.fetch,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function buildServerForCommand(commandLine: string, port: number) {
  const processInfo = new Map<number, LocalServerProcessInfo>([[123, { ppid: 1, commandLine }]]);
  return buildLocalServerProcesses(
    parseLsofTcpListenOutput(["p123", "cnode", "PTCP", `n127.0.0.1:${port}`].join("\n")),
    processInfo,
  );
}

describe("localServerMonitor", () => {
  it("parses lsof listener records into local endpoints", () => {
    const listeners = parseLsofTcpListenOutput(
      [
        "p123",
        "cnode",
        "f12",
        "PTCP",
        "n127.0.0.1:5173",
        "f13",
        "PTCP",
        "n[::1]:5173",
        "p456",
        "cPython",
        "f9",
        "PTCP",
        "n*:8000",
      ].join("\n"),
    );

    expect(listeners).toEqual([
      { pid: 123, command: "node", protocol: "tcp", host: "127.0.0.1", port: 5173, family: "tcp4" },
      { pid: 123, command: "node", protocol: "tcp", host: "::1", port: 5173, family: "tcp6" },
      { pid: 456, command: "Python", protocol: "tcp", host: "*", port: 8000, family: "tcp" },
    ]);
  });

  it("extracts a readable title from local server HTML", () => {
    expect(
      extractLocalServerPageTitle(`
        <!doctype html>
        <html>
          <head>
            <meta property="og:title" content="Customer &amp; Admin">
            <title>Fallback</title>
          </head>
        </html>
      `),
    ).toBe("Customer & Admin");

    expect(extractLocalServerPageTitle("<title>\n  Vite + React&nbsp;Dashboard\n</title>")).toBe(
      "Vite + React Dashboard",
    );
  });

  it("keeps dev servers and ignores Electron/Synara-style application listeners", () => {
    expect(
      detectDevServerKindFromText({
        command: "node",
        args: "node ./node_modules/.bin/vite --host 127.0.0.1",
        ports: [5173],
      }),
    ).toBe("Vite");
    expect(
      isIgnoredLocalServerProcess({
        command: "Electron",
        args: "/Applications/Synara.app/Contents/MacOS/Synara",
        ports: [61449],
      }),
    ).toBe(true);
    expect(
      isIgnoredLocalServerProcess({
        command: "Synara",
        args: "/Applications/Synara.app/Contents/MacOS/Synara",
        ports: [61449],
      }),
    ).toBe(true);
    expect(
      detectDevServerKindFromText({
        command: "node",
        args: "node /Users/emanueledipietro/Developer/synara/apps/web/node_modules/.bin/vite",
        ports: [5733],
      }),
    ).toBe("Vite");
    expect(
      detectDevServerKindFromText({
        command: "bun",
        args: "bun run electron:dev",
        ports: [5733],
      }),
    ).toBe("Dev Server");
  });

  it("ignores Chromium/Electron app helpers that hold a dev-range port (e.g. Discord on :6463)", () => {
    const discordRenderer = {
      command: "Discord Helper (Renderer)",
      args: "/Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer).app/Contents/MacOS/Discord Helper (Renderer) --type=renderer --enable-sandbox",
      ports: [6463],
    };
    expect(isIgnoredLocalServerProcess(discordRenderer)).toBe(true);

    // Filtered by the helper name alone, even without the full Chromium arg list.
    expect(
      isIgnoredLocalServerProcess({
        command: "Slack Helper (GPU)",
        args: "Slack Helper (GPU)",
        ports: [6463],
      }),
    ).toBe(true);

    // A real dev server on the same port range stays visible.
    expect(
      detectDevServerKindFromText({
        command: "node",
        args: "node ./node_modules/.bin/vite --port 6006",
        ports: [6006],
      }),
    ).toBe("Vite");
  });

  it("does not promote databases or port-only listeners to local dev servers", () => {
    expect(
      detectDevServerKindFromText({
        command: "mongod",
        args: "mongod --config /opt/homebrew/etc/mongod.conf",
        ports: [27017],
      }),
    ).toBe(null);
    expect(
      detectDevServerKindFromText({
        command: "go",
        args: "go run ./cmd/web",
        ports: [8080],
      }),
    ).toBe("Go");

    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "node server.js" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", "n127.0.0.1:5733"].join("\n")),
      processInfo,
    );

    expect(servers).toHaveLength(0);
  });

  it("treats custom electron dev scripts as dev context without showing Electron helpers", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [
        123,
        {
          ppid: 1,
          commandLine: "bun run electron:dev",
        },
      ],
      [
        456,
        {
          ppid: 123,
          commandLine: "Electron Helper (Renderer) --type=renderer",
        },
      ],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(
        [
          "p123",
          "cbun",
          "PTCP",
          "n127.0.0.1:5733",
          "p456",
          "cElectron Helper (Renderer)",
          "PTCP",
          "n127.0.0.1:6463",
        ].join("\n"),
      ),
      processInfo,
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      displayName: "Dev Server",
      ports: [5733],
    });
  });

  it("uses parent command lines when a dev-tool child owns the listening port", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [
        12095,
        {
          ppid: 12094,
          commandLine: "next-server (v16.2.3)",
        },
      ],
      [
        12094,
        {
          ppid: 12064,
          commandLine:
            "node /Users/emanueledipietro/Developer/synara-website/node_modules/.bin/next dev",
        },
      ],
      [
        12064,
        {
          ppid: 10212,
          commandLine: "npm run dev",
        },
      ],
    ]);

    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p12095", "cnode", "PTCP", "n*:3000"].join("\n")),
      processInfo,
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      pid: 12095,
      ppid: 12094,
      displayName: "Next.js",
      args: "next-server (v16.2.3)",
      ports: [3000],
    });
  });

  it("groups one process with multiple listener addresses into one row", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "node ./node_modules/.bin/vite" }],
    ]);

    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(
        ["p123", "cnode", "PTCP", "n127.0.0.1:5173", "PTCP", "n*:5173"].join("\n"),
      ),
      processInfo,
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]?.displayName).toBe("Vite");
    expect(servers[0]?.ports).toEqual([5173]);
    expect(servers[0]?.addresses.map((address) => address.url)).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
  });

  it("adds page titles to detected local server rows", async () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "node ./node_modules/.bin/vite" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", "n127.0.0.1:5173"].join("\n")),
      processInfo,
    );

    const enriched = await enrichLocalServerProcessesWithPageTitles(servers, async (url) =>
      url === "http://127.0.0.1:5173" ? "Acme Admin" : null,
    );

    expect(enriched[0]?.displayName).toBe("Vite");
    expect(enriched[0]?.pageTitle).toBe("Acme Admin");
  });

  it.each([
    ["Expo CLI", "node ./node_modules/@expo/cli/build/bin/cli start", "Expo"],
    ["Expo through bunx", "bunx expo start", "Expo"],
    ["standalone Metro", "node ./node_modules/metro/src/index.js", "Metro"],
    ["React Native CLI", "react-native start", "Metro"],
  ])("keeps %s visible without probing it", async (_case, commandLine, displayName) => {
    const servers = buildServerForCommand(commandLine, 8081);
    const fetchTitle = vi.fn(async () => "Unexpected browser title");

    const enriched = await enrichLocalServerProcessesWithPageTitles(servers, fetchTitle);

    expect(enriched[0]).toMatchObject({
      displayName,
      ports: [8081],
    });
    expect(fetchTitle).not.toHaveBeenCalled();
  });

  it("allows page-title probing when Expo is explicitly started for web", async () => {
    const servers = buildServerForCommand(
      "node ./node_modules/@expo/cli/build/bin/cli start --web",
      8081,
    );
    const fetchTitle = vi.fn(async () => "Expo Web");

    const enriched = await enrichLocalServerProcessesWithPageTitles(servers, fetchTitle);

    expect(enriched[0]).toMatchObject({
      displayName: "Expo",
      pageTitle: "Expo Web",
    });
    expect(fetchTitle).toHaveBeenCalledOnce();
  });

  it("uses parent process arguments to recognize Expo web mode", async () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 456, commandLine: "node generic-listener.js" }],
      [456, { ppid: 1, commandLine: "bunx expo start --web" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", "n127.0.0.1:8081"].join("\n")),
      processInfo,
    );
    const fetchTitle = vi.fn(async () => "Expo Web");

    const enriched = await enrichLocalServerProcessesWithPageTitles(servers, fetchTitle);

    expect(enriched[0]).toMatchObject({ displayName: "Expo", pageTitle: "Expo Web" });
    expect(fetchTitle).toHaveBeenCalledOnce();
  });

  it("classifies from raw lineage context while returning only redacted arguments", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 456, commandLine: "node generic-listener.js" }],
      [
        456,
        {
          ppid: 1,
          commandLine: "sh -c APP_PASSWORD=[redacted]",
          rawCommandLine: "sh -c APP_PASSWORD=secret npm run dev",
        },
      ],
    ]);

    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", "n127.0.0.1:5173"].join("\n")),
      processInfo,
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]?.args).toBe("node generic-listener.js");
    expect(JSON.stringify(servers[0])).not.toContain("secret");
  });

  it("keeps full raw lineage context beyond the bounded display arguments", () => {
    const secret = "s".repeat(1_100);
    const processInfo = parseProcessInfo(
      ["123 456 node generic-listener.js", `456 1 sh -c AUTH_TOKEN=${secret} npm run dev`].join(
        "\n",
      ),
    );

    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", "n127.0.0.1:5173"].join("\n")),
      processInfo,
    );

    expect(servers).toHaveLength(1);
    expect(JSON.stringify(servers[0])).not.toContain(secret);
  });

  it("does not classify browser servers from project directory names", async () => {
    const servers = buildServerForCommand(
      "node /projects/expo-app/node_modules/vite/bin/vite.js",
      5173,
    );
    const fetchTitle = vi.fn(async () => "Vite App");

    const enriched = await enrichLocalServerProcessesWithPageTitles(servers, fetchTitle);

    expect(enriched[0]).toMatchObject({ displayName: "Vite", pageTitle: "Vite App" });
    expect(fetchTitle).toHaveBeenCalledOnce();
  });

  it("keeps page-title redirects on local/private hosts", async () => {
    const port = 59173;
    const startUrl = `http://127.0.0.1:${port}`;
    const redirectedUrl = `http://127.0.0.1:${port}/app`;
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "node ./node_modules/.bin/vite" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", `n127.0.0.1:${port}`].join("\n")),
      processInfo,
    );
    const fetchedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: FetchInput) => {
      const url = input.toString();
      fetchedUrls.push(url);
      if (url === startUrl) {
        return new Response(null, { status: 302, headers: { location: "/app" } });
      }
      return new Response("<title>Local Redirect</title>", {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof globalThis.fetch;

    const enriched = await withMockedFetch(fetchMock, () =>
      enrichLocalServerProcessesWithPageTitles(servers),
    );

    expect(fetchedUrls).toEqual([startUrl, redirectedUrl]);
    expect(enriched[0]?.pageTitle).toBe("Local Redirect");
  });

  it("does not follow page-title redirects to external hosts", async () => {
    const port = 59174;
    const startUrl = `http://127.0.0.1:${port}`;
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "node ./node_modules/.bin/vite" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", `n127.0.0.1:${port}`].join("\n")),
      processInfo,
    );
    const fetchedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = input.toString();
      fetchedUrls.push(url);
      if (url === startUrl) {
        if (init?.redirect === "follow") {
          fetchedUrls.push("https://example.com/");
          return new Response("<title>External Redirect</title>", {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/" },
        });
      }
      return new Response("<title>External Redirect</title>", {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof globalThis.fetch;

    const enriched = await withMockedFetch(fetchMock, () =>
      enrichLocalServerProcessesWithPageTitles(servers),
    );

    expect(fetchedUrls).toEqual([startUrl]);
    expect(enriched[0]?.pageTitle).toBeUndefined();
  });

  it("parses lsof cwd records into a pid -> directory map", () => {
    const cwdByPid = parseLsofCwdOutput(
      ["p123", "fcwd", "n/Users/dev/app", "p456", "fcwd", "n/Users/dev/api"].join("\n"),
    );

    expect(cwdByPid.get(123)).toBe("/Users/dev/app");
    expect(cwdByPid.get(456)).toBe("/Users/dev/api");
    expect(cwdByPid.size).toBe(2);
  });

  it("keeps the first cwd line and ignores malformed records", () => {
    const cwdByPid = parseLsofCwdOutput(
      ["px", "n/ignored", "p789", "n/Users/dev/web", "n/Users/dev/other"].join("\n"),
    );

    expect(cwdByPid.get(789)).toBe("/Users/dev/web");
    expect(cwdByPid.size).toBe(1);
  });

  it("attaches a resolved cwd to the built server row", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "vite" }],
    ]);
    const cwdByPid = new Map<number, string>([[123, "/Users/dev/app"]]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", "n127.0.0.1:5173"].join("\n")),
      processInfo,
      cwdByPid,
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]?.cwd).toBe("/Users/dev/app");
  });

  it("falls back to an ancestor cwd when the listening child has none", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [456, { ppid: 123, commandLine: "node child" }],
      [123, { ppid: 1, commandLine: "bun run dev" }],
    ]);
    const cwdByPid = new Map<number, string>([[123, "/Users/dev/monorepo"]]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p456", "cnode", "PTCP", "n127.0.0.1:5173"].join("\n")),
      processInfo,
      cwdByPid,
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]?.cwd).toBe("/Users/dev/monorepo");
  });

  it("omits cwd when it cannot be resolved", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "vite" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", "n127.0.0.1:5173"].join("\n")),
      processInfo,
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]?.cwd).toBeUndefined();
  });
});

describe("full scan mode", () => {
  function buildAllServerForCommand(commandLine: string, port: number, command = "node") {
    const processInfo = new Map<number, LocalServerProcessInfo>([[123, { ppid: 1, commandLine }]]);
    return buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", `c${command}`, "PTCP", `n127.0.0.1:${port}`].join("\n")),
      processInfo,
      new Map(),
      "all",
    );
  }

  it("reports a generic process under its executable name", () => {
    const servers = buildAllServerForCommand(
      "/opt/homebrew/bin/opencode.exe serve",
      53536,
      "opencode",
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ displayName: "opencode.exe", ports: [53536] });
  });

  it("drops non-dev listeners in dev mode", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "/opt/homebrew/bin/opencode.exe serve" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "copencode", "PTCP", "n127.0.0.1:53536"].join("\n")),
      processInfo,
    );

    expect(servers).toHaveLength(0);
  });

  it("keeps dev-kind labels in all mode", () => {
    const servers = buildAllServerForCommand("node ./node_modules/.bin/vite", 5173);

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ displayName: "Vite" });
  });

  it("includes databases and privileged ports in all mode", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "postgres -D /usr/local/var/postgres" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cpostgres", "PTCP", "n127.0.0.1:5432"].join("\n")),
      processInfo,
      new Map(),
      "all",
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ displayName: "postgres", ports: [5432] });
  });

  it("still drops chromium children in all mode", () => {
    const servers = buildAllServerForCommand(
      "/Applications/Discord.app/Contents/Frameworks/Discord Helper --type=renderer --port=6463",
      6463,
    );

    expect(servers).toHaveLength(0);
  });

  it("never probes non-dev listeners for page titles", async () => {
    const servers = buildAllServerForCommand("/usr/local/bin/node /srv/app.js", 3000);
    const fetchTitle = vi.fn(async () => "Unexpected browser title");

    const enriched = await enrichLocalServerProcessesWithPageTitles(servers, fetchTitle);

    expect(fetchTitle).not.toHaveBeenCalled();
    expect(enriched[0]?.pageTitle).toBeUndefined();
    expect(enriched[0]?.displayName).toBe("node");
  });
});

describe("isExcludedFromFullScan", () => {
  it("keeps databases and privileged ports visible", () => {
    expect(
      isExcludedFromFullScan({ command: "postgres", args: "postgres -D /data", ports: [5432] }),
    ).toBe(false);
    expect(
      isExcludedFromFullScan({ command: "nginx", args: "nginx: master process", ports: [443] }),
    ).toBe(false);
  });

  it("still drops chromium children, desktop helpers, and synara itself", () => {
    expect(
      isExcludedFromFullScan({
        command: "Discord Helper",
        args: "/Applications/Discord.app/Contents/Frameworks/Discord Helper --type=renderer",
        ports: [6463],
      }),
    ).toBe(true);
    expect(
      isExcludedFromFullScan({ command: "synara", args: "synara serve", ports: [52345] }),
    ).toBe(true);
    expect(
      isExcludedFromFullScan({
        command: "Spotify",
        args: "/Applications/Spotify.app/Contents/MacOS/Spotify",
        ports: [4370],
      }),
    ).toBe(true);
  });
});

describe("resolveOwnListenerPorts", () => {
  it("reads Synara's server and web ports from the environment", () => {
    expect(resolveOwnListenerPorts({ SYNARA_PORT: "58090", PORT: "8891" })).toEqual([58090, 8891]);
  });

  it("ignores missing or invalid values", () => {
    expect(resolveOwnListenerPorts({})).toEqual([]);
    expect(resolveOwnListenerPorts({ SYNARA_PORT: "not-a-port", PORT: "99999" })).toEqual([]);
  });
});

describe("excludePortsFromListeners", () => {
  it("drops only the excluded ports, keeping sibling ports of the same process", () => {
    const listeners = parseLsofTcpListenOutput(
      ["p123", "cnode", "PTCP", "n127.0.0.1:8891", "n127.0.0.1:5173"].join("\n"),
    );

    expect(excludePortsFromListeners(listeners, [8891]).map((listener) => listener.port)).toEqual([
      5173,
    ]);
    expect(excludePortsFromListeners(listeners, undefined)).toHaveLength(2);
    expect(excludePortsFromListeners(listeners, [])).toHaveLength(2);
  });
});
