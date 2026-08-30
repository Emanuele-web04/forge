import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import { EDITORS } from "@synara/contracts";
import { FileSystem, Path, Effect } from "effect";

import {
  isCommandAvailable,
  launchDetached,
  resolveAvailableEditors,
  resolveEditorLaunch,
  resolveWindowsEditorUriLaunch,
} from "./open";
import {
  clearWindowsStorePackageDiscoveryCache,
  getEditorWindowsStorePackages,
  resolveWindowsStorePackageDirectory,
  resolveWindowsStorePackageDirectoryFromPowerShell,
  resolveWindowsStorePackageInstallLocation,
} from "./editorAppDiscovery";

function encodeExpectedWindowsEditorUriPath(targetPath: string): string {
  return targetPath
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fakePowerShellAppxScript(installLocation: string): string {
  return `#!/bin/sh\nprintf '%s\\n' ${shellSingleQuote(installLocation)}\n`;
}

it.layer(NodeServices.layer)("resolveEditorLaunch", (it) => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const antigravityLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "antigravity" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(antigravityLaunch, {
        command: "agy",
        args: ["/tmp/workspace"],
      });

      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });

      const vscodeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(vscodeLaunch, {
        command: "code",
        args: ["/tmp/workspace"],
      });

      const traeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "trae" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(traeLaunch, {
        command: "trae",
        args: ["/tmp/workspace"],
      });

      const zedLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(zedLaunch, {
        command: "zed",
        args: ["/tmp/workspace"],
      });

      const windsurfLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "windsurf" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(windsurfLaunch, {
        command: "windsurf",
        args: ["/tmp/workspace"],
      });

      const sublimeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "sublime" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(sublimeLaunch, {
        command: "subl",
        args: ["/tmp/workspace"],
      });

      const ideaLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "idea" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(ideaLaunch, {
        command: "idea",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("uses --goto when editor supports line/column suffixes", () =>
    Effect.gen(function* () {
      const lineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(lineOnly, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/AGENTS.md:48"],
      });

      const lineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "cursor" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(lineAndColumn, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(vscodeLineAndColumn, {
        command: "code",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const ideaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "idea" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(ideaLineAndColumn, {
        command: "idea",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const zedLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "zed" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(zedLineAndColumn, {
        command: "zed",
        args: ["/tmp/workspace/src/open.ts:71:5"],
      });
    }),
  );

  it.effect("falls back to the VS Code URL handler on Windows when the CLI is absent", () =>
    Effect.gen(function* () {
      const launch = yield* resolveEditorLaunch(
        { cwd: "C:\\Users\\Chris\\Project Folder\\src\\open.ts:71:5", editor: "vscode" },
        "win32",
        { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" },
      );

      assert.deepEqual(launch, {
        command: "C:\\Windows\\explorer.exe",
        args: ["vscode://file/C:/Users/Chris/Project%20Folder/src/open.ts:71:5"],
      });
    }),
  );

  it.effect("preserves UNC paths in VS Code URL-handler launches", () =>
    Effect.gen(function* () {
      const launch = yield* resolveEditorLaunch(
        { cwd: "\\\\server\\share\\Project Folder\\src\\open.ts:71:5", editor: "vscode" },
        "win32",
        { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" },
      );

      assert.deepEqual(launch, {
        command: "C:\\Windows\\explorer.exe",
        args: ["vscode://file//server/share/Project%20Folder/src/open.ts:71:5"],
      });
    }),
  );

  it.effect("adds the VS Code URL-handler trailing slash for existing folders", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-vscode-folder-" });
      const folderPath = path.join(dir, "Project Folder");
      yield* fs.makeDirectory(folderPath);

      const launch = yield* resolveEditorLaunch({ cwd: folderPath, editor: "vscode" }, "win32", {
        PATH: "",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: "C:\\Windows",
      });

      assert.deepEqual(launch, {
        command: "C:\\Windows\\explorer.exe",
        args: [`vscode://file/${encodeExpectedWindowsEditorUriPath(folderPath)}/`],
      });
    }),
  );

  it("does not build URL-handler launches for non-Windows platforms", () => {
    const editor = EDITORS.find((candidate) => candidate.id === "vscode");
    assert.ok(editor);
    assert.equal(resolveWindowsEditorUriLaunch(editor, "/tmp/workspace", "linux"), null);
  });

  it.effect("opens terminal-style editors in the target working directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-terminal-" });
      const filePath = path.join(dir, "src", "open.ts");
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, "export const value = 1;\n");

      const ghosttyLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "ghostty" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(ghosttyLaunch, {
        command: "ghostty",
        args: [`--working-directory=${path.dirname(filePath)}`],
      });

      const muxyLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "muxy" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(muxyLaunch, {
        command: "muxy",
        args: [path.dirname(filePath)],
      });

      const binDir = path.join(dir, "bin");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(path.join(binDir, "konsole"), "#!/bin/sh\n");
      yield* fs.chmod(path.join(binDir, "konsole"), 0o755);

      const linuxTerminalLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "terminal" },
        "linux",
        { PATH: binDir },
      );
      assert.deepEqual(linuxTerminalLaunch, {
        command: "konsole",
        args: ["--workdir", path.dirname(filePath)],
      });

      const linuxTerminalFallbackLaunch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:71:5`, editor: "terminal" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(linuxTerminalFallbackLaunch, {
        command: "x-terminal-emulator",
        args: [`--working-directory=${path.dirname(filePath)}`],
      });

      yield* fs.writeFileString(path.join(binDir, "wt.CMD"), "@echo off\r\n");
      const windowsTerminalLaunch = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "terminal" },
        "win32",
        { PATH: binDir, PATHEXT: ".CMD" },
      );
      assert.deepEqual(windowsTerminalLaunch, {
        command: "wt",
        args: ["-d", "C:\\workspace"],
      });
    }),
  );

  it.effect("falls back to installed macOS app bundles when launchers are absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-apps-" });
      yield* fs.makeDirectory(path.join(home, "Applications", "Ghostty.app"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, "Applications", "Muxy.app"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, "Applications", "WebStorm.app"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(home, "Applications", "JetBrains Toolbox", "PyCharm.app"), {
        recursive: true,
      });

      const ghosttyLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "ghostty" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(ghosttyLaunch, {
        command: "open",
        args: ["-a", "Ghostty", "/tmp/workspace"],
      });

      const muxyLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "muxy" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(muxyLaunch, {
        command: "open",
        args: ["-a", "Muxy", "/tmp/workspace"],
      });

      const terminalLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "terminal" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(terminalLaunch, {
        command: "open",
        args: ["-a", "Terminal", "/tmp/workspace"],
      });

      const webstormLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "webstorm" },
        "darwin",
        { HOME: home, PATH: "" },
      );
      assert.deepEqual(webstormLaunch, {
        command: "open",
        args: [
          "-a",
          "WebStorm",
          "--args",
          "--line",
          "71",
          "--column",
          "5",
          "/tmp/workspace/src/open.ts",
        ],
      });

      const availableEditors = resolveAvailableEditors("darwin", { HOME: home, PATH: "" });
      assert.equal(availableEditors.includes("ghostty"), true);
      assert.equal(availableEditors.includes("muxy"), true);
      assert.equal(availableEditors.includes("webstorm"), true);
      assert.equal(availableEditors.includes("pycharm"), true);
    }),
  );

  it.effect("prefers the macOS Ghostty app launch even when a ghostty command is on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-ghostty-" });
      const binDir = path.join(home, "bin");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(path.join(binDir, "ghostty"), "#!/bin/sh\n");
      yield* fs.chmod(path.join(binDir, "ghostty"), 0o755);
      yield* fs.makeDirectory(path.join(home, "Applications", "Ghostty.app"), {
        recursive: true,
      });

      const launch = yield* resolveEditorLaunch(
        { cwd: "/tmp/with space/workspace", editor: "ghostty" },
        "darwin",
        { HOME: home, PATH: binDir },
      );

      assert.deepEqual(launch, {
        command: "open",
        args: ["-a", "Ghostty", "/tmp/with space/workspace"],
      });
    }),
  );

  it.effect("reveals macOS files in Finder while opening directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentPath = yield* fs.makeTempDirectoryScoped({
        prefix: "synara-file-manager-",
      });
      const directoryPath = path.join(parentPath, "Project Folder");
      const filePath = path.join(directoryPath, "source file.ts");
      yield* fs.makeDirectory(directoryPath);
      yield* fs.writeFileString(filePath, "");

      const fileLaunch = yield* resolveEditorLaunch(
        { cwd: filePath, editor: "file-manager" },
        "darwin",
      );
      assert.deepEqual(fileLaunch, {
        command: "open",
        args: ["-R", filePath],
      });

      const directoryLaunch = yield* resolveEditorLaunch(
        { cwd: directoryPath, editor: "file-manager" },
        "darwin",
      );
      assert.deepEqual(directoryLaunch, {
        command: "open",
        args: [directoryPath],
      });
    }),
  );

  it.effect("falls back to opening macOS targets when metadata lookup fails", () =>
    Effect.gen(function* () {
      const targetPath = `/${"unavailable".repeat(500)}`;
      const launch = yield* resolveEditorLaunch(
        { cwd: targetPath, editor: "file-manager" },
        "darwin",
      );

      assert.deepEqual(launch, {
        command: "open",
        args: [targetPath],
      });
    }),
  );

  it.effect("maps file-manager editor to Windows and Linux open commands", () =>
    Effect.gen(function* () {
      const windowsLaunch = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        "win32",
      );
      assert.deepEqual(windowsLaunch, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const linuxLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
      );
      assert.deepEqual(linuxLaunch, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );
});

it.layer(NodeServices.layer)("launchDetached", (it) => {
  it.effect("resolves when command can be spawned", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }).pipe(Effect.result);
      assertSuccess(result, undefined);
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `synara-no-such-command-${Date.now()}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});

it.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("resolves win32 commands with PATHEXT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-test-" });
      yield* fs.writeFileString(path.join(dir, "code.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );

  it("returns false when a command is not on PATH", () => {
    const env = {
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(isCommandAvailable("definitely-not-installed", { platform: "win32", env }), false);
  });

  it.effect("does not treat bare files without executable extension as available on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-test-" });
      yield* fs.writeFileString(path.join(dir, "npm"), "echo nope\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("npm", { platform: "win32", env }), false);
    }),
  );

  it.effect("appends PATHEXT for commands with non-executable extensions on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-test-" });
      yield* fs.writeFileString(path.join(dir, "my.tool.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("my.tool", { platform: "win32", env }), true);
    }),
  );

  it.effect("uses platform-specific PATH delimiter for platform overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const firstDir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-test-" });
      const secondDir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-open-test-" });
      yield* fs.writeFileString(path.join(firstDir, "code.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(secondDir, "code.CMD"), "MZ");
      const env = {
        PATH: `${firstDir};${secondDir}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );
});

it.layer(NodeServices.layer)("resolveAvailableEditors", (it) => {
  it.effect("returns installed editors for command launches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-editors-" });

      yield* fs.writeFileString(path.join(dir, "cursor.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "code-insiders.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "zeditor.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "explorer.CMD"), "MZ");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, ["cursor", "vscode-insiders", "zed", "file-manager"]);
    }),
  );

  it.effect("returns VS Code when the Windows Store package is installed without a CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const programFiles = yield* fs.makeTempDirectoryScoped({ prefix: "synara-vscode-store-" });
      const binDir = path.join(programFiles, "bin");
      const installLocation = path.join(
        programFiles,
        "WindowsApps",
        "Microsoft.VisualStudioCode_1.0.0.0_x64__8wekyb3d8bbwe",
      );
      yield* fs.makeDirectory(installLocation, { recursive: true });
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(binDir, "powershell.exe"),
        fakePowerShellAppxScript(installLocation),
      );
      yield* fs.chmod(path.join(binDir, "powershell.exe"), 0o755);

      clearWindowsStorePackageDiscoveryCache();

      const editors = resolveAvailableEditors("win32", {
        PATH: binDir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ProgramFiles: programFiles,
      });

      assert.equal(editors.includes("vscode"), true);
    }),
  );

  it.effect("does not treat Windows app-execution-alias folders as package installs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const localAppData = yield* fs.makeTempDirectoryScoped({
        prefix: "synara-vscode-store-alias-",
      });
      yield* fs.makeDirectory(
        path.join(
          localAppData,
          "Microsoft",
          "WindowsApps",
          "Microsoft.VisualStudioCode_8wekyb3d8bbwe",
        ),
        { recursive: true },
      );
      const editor = EDITORS.find((candidate) => candidate.id === "vscode");
      assert.ok(editor);

      assert.equal(
        resolveWindowsStorePackageDirectory(getEditorWindowsStorePackages(editor), "win32", {
          LOCALAPPDATA: localAppData,
        }),
        null,
      );
    }),
  );

  it("resolves Windows Store package locations through matching AppX registration", () => {
    const editor = EDITORS.find((candidate) => candidate.id === "vscode");
    assert.ok(editor);
    const installLocation =
      "C:\\Program Files\\WindowsApps\\Microsoft.VisualStudioCode_1.0.0.0_x64__8wekyb3d8bbwe";
    let script = "";

    const result = resolveWindowsStorePackageDirectoryFromPowerShell(
      getEditorWindowsStorePackages(editor),
      "win32",
      { PATH: "" },
      (_file, args) => {
        script = String(args[2]);
        return `${installLocation}\r\n`;
      },
    );

    assert.equal(result, installLocation);
    assert.equal(script.includes("PackageFamilyName -ieq $packageDef.Family"), true);
    assert.equal(script.includes("Microsoft.VisualStudioCode_8wekyb3d8bbwe"), true);
  });

  it("caches Windows Store AppX registration probes", () => {
    clearWindowsStorePackageDiscoveryCache();
    const editor = EDITORS.find((candidate) => candidate.id === "vscode");
    assert.ok(editor);
    const installLocation =
      "C:\\Program Files\\WindowsApps\\Microsoft.VisualStudioCode_1.0.0.0_x64__8wekyb3d8bbwe";
    let calls = 0;

    const first = resolveWindowsStorePackageDirectoryFromPowerShell(
      getEditorWindowsStorePackages(editor),
      "win32",
      { PATH: "C:\\Windows\\System32" },
      () => {
        calls += 1;
        return `${installLocation}\r\n`;
      },
      { useCache: true, now: () => 1_000 },
    );
    const second = resolveWindowsStorePackageDirectoryFromPowerShell(
      getEditorWindowsStorePackages(editor),
      "win32",
      { PATH: "C:\\Windows\\System32" },
      () => {
        calls += 1;
        return "C:\\wrong\r\n";
      },
      { useCache: true, now: () => 1_100 },
    );

    assert.equal(first, installLocation);
    assert.equal(second, installLocation);
    assert.equal(calls, 1);
    clearWindowsStorePackageDiscoveryCache();
  });

  it.effect("does not treat filesystem-only AppX package directories as installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const editor = EDITORS.find((candidate) => candidate.id === "vscode");
      assert.ok(editor);
      const programFiles = yield* fs.makeTempDirectoryScoped({ prefix: "synara-vscode-staged-" });
      yield* fs.makeDirectory(
        path.join(
          programFiles,
          "WindowsApps",
          "Microsoft.VisualStudioCode_1.0.0.0_x64__8wekyb3d8bbwe",
        ),
        { recursive: true },
      );

      const installLocation = resolveWindowsStorePackageInstallLocation(
        getEditorWindowsStorePackages(editor),
        "win32",
        { PATH: "", ProgramFiles: programFiles },
        () => {
          throw new Error("not registered");
        },
        { useCache: false },
      );

      assert.equal(installLocation, null);
    }),
  );
});
