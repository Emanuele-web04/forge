import { describe, expect, it } from "vitest";

import type { ServerLocalServerProcess } from "@synara/contracts";

import {
  formatPortAddress,
  groupListeningPorts,
  localServerAddressLabel,
  localServerFolderLabel,
  localServerMatchesRun,
  localServerPrimaryLabel,
  toPortProjectSources,
} from "./localServers";

function makeServer(overrides: Partial<ServerLocalServerProcess>): ServerLocalServerProcess {
  return {
    id: "srv-1",
    pid: 2518,
    command: "node",
    displayName: "Vite",
    args: "",
    ports: [],
    addresses: [],
    isStoppable: true,
    ...overrides,
  };
}

describe("localServerAddressLabel", () => {
  it("renders a single port as localhost:<port>", () => {
    expect(localServerAddressLabel(makeServer({ ports: [5733] }))).toBe("localhost:5733");
  });

  it("joins multiple ports", () => {
    expect(localServerAddressLabel(makeServer({ ports: [5733, 8891] }))).toBe(
      "localhost:5733, localhost:8891",
    );
  });

  it("never echoes the raw bind host (ipv6 loopback) — falls back to localhost", () => {
    const server = makeServer({
      ports: [],
      addresses: [{ host: "::1", port: 5733, family: "tcp6", url: "http://[::1]:5733" }],
    });
    expect(localServerAddressLabel(server)).toBe("localhost:5733");
  });

  it("falls back to a bare localhost when no port is known", () => {
    expect(localServerAddressLabel(makeServer({}))).toBe("localhost");
  });
});

describe("localServerPrimaryLabel", () => {
  it("prefers the live page title when one was resolved", () => {
    expect(localServerPrimaryLabel(makeServer({ pageTitle: "Synara", displayName: "Vite" }))).toBe(
      "Synara",
    );
  });

  it("falls back to the detected display name when no page title is known", () => {
    expect(localServerPrimaryLabel(makeServer({ displayName: "Next.js" }))).toBe("Next.js");
  });
});

describe("localServerFolderLabel", () => {
  it("returns the final segment of a POSIX cwd", () => {
    expect(localServerFolderLabel(makeServer({ cwd: "/Users/me/Developer/synara-website" }))).toBe(
      "synara-website",
    );
  });

  it("ignores a trailing separator", () => {
    expect(localServerFolderLabel(makeServer({ cwd: "/Users/me/Developer/synara/" }))).toBe(
      "synara",
    );
  });

  it("tolerates Windows separators", () => {
    expect(localServerFolderLabel(makeServer({ cwd: "C:\\Users\\me\\projects\\app" }))).toBe("app");
  });

  it("returns null when the cwd is unknown", () => {
    expect(localServerFolderLabel(makeServer({}))).toBeNull();
  });

  it("returns null when the cwd is only separators", () => {
    expect(localServerFolderLabel(makeServer({ cwd: "/" }))).toBeNull();
  });
});

describe("localServerMatchesRun", () => {
  it("matches a server whose pid is the tracked run pid", () => {
    expect(
      localServerMatchesRun(makeServer({ pid: 200 }), {
        pid: 200,
        cwd: "/repo/app",
      }),
    ).toBe(true);
  });

  it("matches a server whose parent pid is the tracked run pid", () => {
    expect(
      localServerMatchesRun(makeServer({ pid: 200, ppid: 100 }), {
        pid: 100,
        cwd: "/repo/app",
      }),
    ).toBe(true);
  });

  it("falls back to cwd containment for nested listening children", () => {
    expect(
      localServerMatchesRun(makeServer({ pid: 200, cwd: "/repo/app/packages/web" }), {
        pid: 100,
        cwd: "/repo/app",
      }),
    ).toBe(true);
  });

  it("does not match sibling folders with the same prefix", () => {
    expect(
      localServerMatchesRun(makeServer({ cwd: "/repo/app-other" }), {
        pid: null,
        cwd: "/repo/app",
      }),
    ).toBe(false);
  });
});

describe("formatPortAddress", () => {
  it("preserves loopback and hostname binds", () => {
    expect(formatPortAddress("127.0.0.1", 53456)).toBe("127.0.0.1:53456");
    expect(formatPortAddress("localhost", 3000)).toBe("localhost:3000");
  });

  it("brackets IPv6 hosts", () => {
    expect(formatPortAddress("::1", 3000)).toBe("[::1]:3000");
  });

  it("keeps wildcard binds explicit", () => {
    expect(formatPortAddress("*", 8000)).toBe("*:8000");
    expect(formatPortAddress("", 8000)).toBe("*:8000");
  });
});

describe("groupListeningPorts", () => {
  const projects = [
    { id: "p1", title: "claudex", roots: ["/Users/me/claudex"] },
    { id: "p2", title: "projects", roots: ["/Users/me/projects"] },
  ];

  function portServer(
    pid: number,
    port: number,
    host: string,
    cwd?: string,
    displayName = "node",
  ): ServerLocalServerProcess {
    return makeServer({
      id: `${pid}:${port}`,
      pid,
      displayName,
      cwd,
      ports: [port],
      addresses: [{ host, port, family: "tcp4", url: `http://${host}:${port}` }],
    });
  }

  it("groups workspace ports by project and leaves the rest external", () => {
    const grouped = groupListeningPorts(
      [
        portServer(11, 53456, "127.0.0.1", "/Users/me/claudex", "opencode.exe"),
        portServer(22, 3000, "127.0.0.1", "/Users/me/projects/demo"),
        portServer(33, 7000, "127.0.0.1", undefined, "airplay"),
      ],
      projects,
    );

    expect(grouped.groups.map((group) => group.projectTitle)).toEqual(["claudex", "projects"]);
    expect(grouped.groups[0]?.rows).toHaveLength(1);
    expect(grouped.groups[0]?.rows[0]).toMatchObject({
      port: 53456,
      pid: 11,
      displayName: "opencode.exe",
      address: "127.0.0.1:53456",
    });
    expect(grouped.external.map((row) => row.port)).toEqual([7000]);
    expect(grouped.workspaceCount).toBe(2);
    expect(grouped.externalCount).toBe(1);
    expect(grouped.totalCount).toBe(3);
  });

  it("does not match sibling folders with the same prefix", () => {
    const grouped = groupListeningPorts(
      [portServer(11, 3000, "127.0.0.1", "/Users/me/claudex-fork")],
      projects,
    );

    expect(grouped.groups).toHaveLength(0);
    expect(grouped.external).toHaveLength(1);
  });

  it("sorts ports numerically within a group", () => {
    const grouped = groupListeningPorts(
      [
        portServer(11, 53536, "127.0.0.1", "/Users/me/claudex"),
        portServer(12, 53456, "127.0.0.1", "/Users/me/claudex"),
      ],
      projects,
    );

    expect(grouped.groups[0]?.rows.map((row) => row.port)).toEqual([53456, 53536]);
  });

  it("prefers the most specific project root over a home-rooted catch-all", () => {
    const nested = [
      { id: "home", title: "Home", roots: ["/Users/me"] },
      { id: "p1", title: "claudex", roots: ["/Users/me/claudex"] },
    ];
    const grouped = groupListeningPorts(
      [
        portServer(11, 53456, "127.0.0.1", "/Users/me/claudex"),
        portServer(22, 3773, "127.0.0.1", "/Users/me"),
        portServer(33, 7000, "127.0.0.1", "/Users/me/Library/Razer"),
      ],
      nested,
    );

    expect(grouped.groups.map((group) => group.projectTitle)).toEqual(["claudex", "Home"]);
    expect(grouped.groups[0]?.rows.map((row) => row.port)).toEqual([53456]);
    expect(grouped.groups[1]?.rows.map((row) => row.port)).toEqual([3773, 7000]);
  });
});

describe("toPortProjectSources", () => {
  const inputs = [
    { id: "home", title: "Home", cwd: "/Users/me", sources: [] },
    {
      id: "p1",
      title: "claudex",
      cwd: "/Users/me/projects/claudex",
      sources: [{ path: "/Users/me/work/claudex-docs" }],
    },
  ];

  it("drops home-directory roots so the catch-all project never owns ports", () => {
    expect(toPortProjectSources(inputs, "/Users/me")).toEqual([
      { id: "home", title: "Home", roots: [] },
      {
        id: "p1",
        title: "claudex",
        roots: ["/Users/me/projects/claudex", "/Users/me/work/claudex-docs"],
      },
    ]);
  });

  it("keeps every root when no home directory is known", () => {
    const sources = toPortProjectSources(inputs, null);
    expect(sources[0]?.roots).toEqual(["/Users/me"]);
  });

  it("ports under home fall back to external once Home is excluded", () => {
    const grouped = groupListeningPorts(
      [
        makeServer({
          id: "1:3773",
          pid: 1,
          displayName: "T3",
          cwd: "/Users/me",
          ports: [3773],
          addresses: [{ host: "*", port: 3773, family: "tcp", url: "http://localhost:3773" }],
        }),
      ],
      toPortProjectSources(inputs, "/Users/me"),
    );

    expect(grouped.groups).toHaveLength(0);
    expect(grouped.external.map((row) => row.port)).toEqual([3773]);
  });
});
