// FILE: editor.ts
// Purpose: Define editor ids and launch metadata shared by the client and server.
// Layer: Shared contracts
// Exports: EDITORS, EditorId, OpenInEditorInput

import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const EditorLaunchStyle = Schema.Literals([
  "direct-path",
  "goto",
  "line-column",
  "terminal-working-directory",
]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly [string, ...string[]] | null;
  readonly macApplications?: readonly [string, ...string[]];
  readonly windowsUriScheme?: string;
  readonly windowsStorePackages?: readonly [
    WindowsStorePackageDefinition,
    ...WindowsStorePackageDefinition[],
  ];
  readonly launchStyle: EditorLaunchStyle;
};

type WindowsStorePackageDefinition = {
  readonly packageName: string;
  readonly publisherId: string;
};

export const EDITORS = [
  {
    id: "cursor",
    label: "Cursor",
    commands: ["cursor"],
    macApplications: ["Cursor"],
    launchStyle: "goto",
  },
  {
    id: "trae",
    label: "Trae",
    commands: ["trae"],
    macApplications: ["Trae"],
    launchStyle: "goto",
  },
  {
    id: "vscode",
    label: "VS Code",
    commands: ["code"],
    macApplications: ["Visual Studio Code"],
    windowsUriScheme: "vscode",
    windowsStorePackages: [
      { packageName: "Microsoft.VisualStudioCode", publisherId: "8wekyb3d8bbwe" },
    ],
    launchStyle: "goto",
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    macApplications: ["Visual Studio Code - Insiders"],
    windowsUriScheme: "vscode-insiders",
    launchStyle: "goto",
  },
  {
    id: "vscodium",
    label: "VSCodium",
    commands: ["codium"],
    macApplications: ["VSCodium"],
    launchStyle: "goto",
  },
  {
    id: "zed",
    label: "Zed",
    commands: ["zed", "zeditor"],
    macApplications: ["Zed"],
    launchStyle: "direct-path",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    commands: ["windsurf"],
    macApplications: ["Windsurf"],
    launchStyle: "goto",
  },
  {
    id: "sublime",
    label: "Sublime Text",
    commands: ["subl"],
    macApplications: ["Sublime Text"],
    launchStyle: "direct-path",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    commands: ["agy"],
    macApplications: ["Antigravity"],
    launchStyle: "goto",
  },
  {
    id: "ghostty",
    label: "Ghostty",
    commands: ["ghostty"],
    macApplications: ["Ghostty"],
    launchStyle: "terminal-working-directory",
  },
  {
    id: "muxy",
    label: "Muxy",
    commands: ["muxy"],
    macApplications: ["Muxy"],
    launchStyle: "terminal-working-directory",
  },
  {
    id: "terminal",
    label: "Terminal",
    commands: [
      "wt",
      "gnome-terminal",
      "kgx",
      "konsole",
      "xfce4-terminal",
      "tilix",
      "terminator",
      "x-terminal-emulator",
      "kitty",
      "alacritty",
      "wezterm",
      "cmd",
      "powershell",
      "pwsh",
    ],
    macApplications: ["Terminal"],
    launchStyle: "terminal-working-directory",
  },
  {
    id: "iterm",
    label: "iTerm",
    commands: ["iterm2"],
    macApplications: ["iTerm"],
    launchStyle: "terminal-working-directory",
  },
  {
    id: "warp",
    label: "Warp",
    commands: ["warp"],
    macApplications: ["Warp"],
    launchStyle: "terminal-working-directory",
  },
  {
    id: "xcode",
    label: "Xcode",
    commands: ["xed"],
    macApplications: ["Xcode"],
    launchStyle: "direct-path",
  },
  {
    id: "idea",
    label: "IntelliJ IDEA",
    commands: ["idea", "idea64", "idea.sh", "intellij-idea"],
    macApplications: [
      "IntelliJ IDEA",
      "IntelliJ IDEA Ultimate",
      "IntelliJ IDEA Community Edition",
      "IntelliJ IDEA CE",
    ],
    launchStyle: "line-column",
  },
  {
    id: "webstorm",
    label: "WebStorm",
    commands: ["webstorm", "wstorm", "webstorm64", "webstorm.sh"],
    macApplications: ["WebStorm"],
    launchStyle: "line-column",
  },
  {
    id: "pycharm",
    label: "PyCharm",
    commands: ["pycharm", "charm", "pycharm64", "pycharm.sh", "pycharm-professional"],
    macApplications: ["PyCharm", "PyCharm Professional", "PyCharm CE"],
    launchStyle: "line-column",
  },
  {
    id: "phpstorm",
    label: "PhpStorm",
    commands: ["phpstorm", "pstorm", "phpstorm64", "phpstorm.sh"],
    macApplications: ["PhpStorm"],
    launchStyle: "line-column",
  },
  {
    id: "goland",
    label: "GoLand",
    commands: ["goland", "goland64", "goland.sh"],
    macApplications: ["GoLand"],
    launchStyle: "line-column",
  },
  {
    id: "clion",
    label: "CLion",
    commands: ["clion", "clion64", "clion.sh"],
    macApplications: ["CLion"],
    launchStyle: "line-column",
  },
  {
    id: "rider",
    label: "Rider",
    commands: ["rider", "rider64", "rider.sh"],
    macApplications: ["Rider"],
    launchStyle: "line-column",
  },
  {
    id: "rubymine",
    label: "RubyMine",
    commands: ["rubymine", "mine", "rubymine64", "rubymine.sh"],
    macApplications: ["RubyMine"],
    launchStyle: "line-column",
  },
  {
    id: "datagrip",
    label: "DataGrip",
    commands: ["datagrip", "datagrip64", "datagrip.sh"],
    macApplications: ["DataGrip"],
    launchStyle: "line-column",
  },
  {
    id: "rustrover",
    label: "RustRover",
    commands: ["rustrover", "rustrover64", "rustrover.sh"],
    macApplications: ["RustRover"],
    launchStyle: "line-column",
  },
  {
    id: "android-studio",
    label: "Android Studio",
    commands: ["studio", "android-studio", "studio.sh"],
    macApplications: ["Android Studio"],
    launchStyle: "line-column",
  },
  { id: "file-manager", label: "File Manager", commands: null, launchStyle: "direct-path" },
  // Opens the target with the OS default handler (e.g. Preview for PDFs on macOS,
  // the registered default viewer on Windows/Linux). Launched via the cross-platform
  // `open` package server-side, so it has no commands/macApplications of its own and
  // is intentionally excluded from `resolveAvailableEditors` — surfaces that want it
  // (the PDF viewer) opt in explicitly rather than cluttering the code-editor menu.
  { id: "system-default", label: "Default app", commands: null, launchStyle: "direct-path" },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export const OpenInEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
});
export type OpenInEditorInput = typeof OpenInEditorInput.Type;
