import { describe, expect, it } from "vitest";

import {
  resolveAppLaunch,
  type AppLaunchEnvironment,
  type AppLaunchFileSystem,
} from "./appLaunchResolution.ts";

const ENV: AppLaunchEnvironment = {
  path: "/usr/bin:/usr/local/bin",
  home: "/home/tester",
  xdgDataDirs: "/usr/share:/usr/local/share",
};

interface FakeHost {
  readonly executables?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
}

function fakeFs(host: FakeHost): AppLaunchFileSystem {
  const executables = new Set(host.executables ?? []);
  const files = host.files ?? {};
  return {
    isExecutableFile: (path) => executables.has(path),
    isFile: (path) => path in files,
    readTextFile: (path) => files[path],
  };
}

function resolve(app: string, args: readonly string[], host: FakeHost) {
  return resolveAppLaunch(app, args, { fs: fakeFs(host), env: ENV });
}

describe("resolveAppLaunch", () => {
  it("uses an absolute path that exists", () => {
    expect(
      resolve("/var/lib/flatpak/exports/bin/app.zen_browser.zen", ["--new-window"], {
        executables: ["/var/lib/flatpak/exports/bin/app.zen_browser.zen"],
      }),
    ).toEqual({
      command: "/var/lib/flatpak/exports/bin/app.zen_browser.zen",
      args: ["--new-window"],
      via: "absolute-path",
    });
  });

  it("refuses an absolute path with nothing executable behind it", () => {
    expect(() => resolve("/usr/bin/nope", [], {})).toThrow(/no executable at/);
  });

  it("refuses a relative path rather than guessing a working directory", () => {
    expect(() => resolve("./kcalc", [], {})).toThrow(/relative path/);
  });

  it("prefers $PATH over the flatpak export bins", () => {
    expect(
      resolve("kcalc", [], {
        executables: ["/usr/bin/kcalc", "/var/lib/flatpak/exports/bin/kcalc"],
      }),
    ).toEqual({ command: "/usr/bin/kcalc", args: [], via: "path" });
  });

  it("resolves a flatpak app id to its system export bin, arguments intact", () => {
    expect(
      resolve("app.zen_browser.zen", ["--new-window", "https://example.com"], {
        executables: ["/var/lib/flatpak/exports/bin/app.zen_browser.zen"],
      }),
    ).toEqual({
      command: "/var/lib/flatpak/exports/bin/app.zen_browser.zen",
      args: ["--new-window", "https://example.com"],
      via: "flatpak-export",
    });
  });

  it("resolves a flatpak app id installed for the user only", () => {
    expect(
      resolve("com.example.Notes", [], {
        executables: ["/home/tester/.local/share/flatpak/exports/bin/com.example.Notes"],
      }),
    ).toMatchObject({
      command: "/home/tester/.local/share/flatpak/exports/bin/com.example.Notes",
      via: "flatpak-export",
    });
  });

  it("honours XDG_DATA_HOME for the per-user flatpak exports", () => {
    expect(
      resolveAppLaunch("com.example.Notes", [], {
        fs: fakeFs({ executables: ["/data/flatpak/exports/bin/com.example.Notes"] }),
        env: { ...ENV, xdgDataHome: "/data" },
      }),
    ).toMatchObject({ command: "/data/flatpak/exports/bin/com.example.Notes" });
  });

  it("launches a desktop entry through its Exec binary, dropping field codes", () => {
    expect(
      resolve("org.example.Editor", ["notes.txt"], {
        executables: ["/usr/bin/example-editor"],
        files: {
          "/usr/share/applications/org.example.Editor.desktop": [
            "[Desktop Entry]",
            "Name=Editor",
            "Exec=example-editor --tab %U",
            "",
            "[Desktop Action new]",
            "Exec=example-editor --new",
          ].join("\n"),
        },
      }),
    ).toEqual({
      command: "/usr/bin/example-editor",
      args: ["--tab", "notes.txt"],
      via: "desktop-entry-exec",
      desktopFile: "/usr/share/applications/org.example.Editor.desktop",
    });
  });

  it("strips flatpak file-forwarding markers from a desktop entry Exec", () => {
    expect(
      resolve("app.zen_browser.zen", ["--new-window"], {
        executables: ["/usr/bin/flatpak"],
        files: {
          "/var/lib/flatpak/exports/share/applications/app.zen_browser.zen.desktop": [
            "[Desktop Entry]",
            "Exec=/usr/bin/flatpak run --branch=stable --file-forwarding app.zen_browser.zen @@u %u @@",
          ].join("\n"),
        },
      }),
    ).toEqual({
      command: "/usr/bin/flatpak",
      args: ["run", "--branch=stable", "--file-forwarding", "app.zen_browser.zen", "--new-window"],
      via: "desktop-entry-exec",
      desktopFile: "/var/lib/flatpak/exports/share/applications/app.zen_browser.zen.desktop",
    });
  });

  it("accepts an id that already carries the .desktop suffix", () => {
    expect(
      resolve("org.example.Editor.desktop", [], {
        executables: ["/usr/bin/example-editor"],
        files: {
          "/home/tester/.local/share/applications/org.example.Editor.desktop":
            "[Desktop Entry]\nExec=example-editor\n",
        },
      }),
    ).toMatchObject({ command: "/usr/bin/example-editor", via: "desktop-entry-exec" });
  });

  it("falls back to gio launch when the Exec binary is missing and no arguments were passed", () => {
    expect(
      resolve("org.example.Editor", [], {
        executables: ["/usr/bin/gio"],
        files: {
          "/usr/share/applications/org.example.Editor.desktop":
            "[Desktop Entry]\nExec=absent-editor %U\n",
        },
      }),
    ).toEqual({
      command: "/usr/bin/gio",
      args: ["launch", "/usr/share/applications/org.example.Editor.desktop"],
      via: "desktop-entry-gio",
    });
  });

  it("refuses rather than dropping arguments gio launch cannot forward", () => {
    expect(() =>
      resolve("org.example.Editor", ["--new-window"], {
        executables: ["/usr/bin/gio"],
        files: {
          "/usr/share/applications/org.example.Editor.desktop":
            "[Desktop Entry]\nExec=absent-editor %U\n",
        },
      }),
    ).toThrow(/arguments you passed cannot be forwarded/);
  });

  it("teaches the model what was searched when nothing matches", () => {
    let message = "";
    try {
      resolve("app.zen_browser.zen", [], {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("app.zen_browser.zen");
    // Kinds rather than paths: the searched directories include the user's
    // home, and the error reaches whoever reads the tool result.
    expect(message).toContain("the PATH");
    expect(message).toContain(".desktop entries");
    expect(message).not.toMatch(/\/home\//);
    expect(message).toContain("computer_list_windows");
  });

  it("rejects a blank app name", () => {
    expect(() => resolve("   ", [], {})).toThrow(/needs a program name/);
  });
});
