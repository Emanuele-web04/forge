# Keybindings

Synara reads keybindings from:

- `~/.synara/userdata/keybindings.json`

The file must be a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts)

## Defaults

```json
[
  { "key": "mod+b", "command": "sidebar.toggle", "when": "!terminalFocus" },
  { "key": "cmd+k", "command": "sidebar.search" },
  { "key": "ctrl+k", "command": "sidebar.search", "when": "!isMac" },
  { "key": "mod+shift+o", "command": "sidebar.addProject", "when": "!terminalFocus" },
  { "key": "mod+i", "command": "sidebar.importThread", "when": "!terminalFocus" },
  { "key": "mod+alt+arrowleft", "command": "space.previous", "when": "!terminalFocus" },
  { "key": "mod+alt+arrowright", "command": "space.next", "when": "!terminalFocus" },
  { "key": "mod+alt+1", "command": "space.jump.1", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+2", "command": "space.jump.2", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+3", "command": "space.jump.3", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+4", "command": "space.jump.4", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+5", "command": "space.jump.5", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+6", "command": "space.jump.6", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+7", "command": "space.jump.7", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+8", "command": "space.jump.8", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+9", "command": "space.jump.9", "when": "!terminalFocus || isMac" },
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+shift+arrowright", "command": "terminal.splitRight", "when": "terminalFocus" },
  { "key": "mod+shift+arrowleft", "command": "terminal.splitLeft", "when": "terminalFocus" },
  { "key": "mod+shift+arrowdown", "command": "terminal.splitDown", "when": "terminalFocus" },
  { "key": "mod+shift+arrowup", "command": "terminal.splitUp", "when": "terminalFocus" },
  { "key": "mod+t", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+shift+j", "command": "terminal.workspace.newFullWidth" },
  { "key": "mod+w", "command": "terminal.workspace.closeActive", "when": "terminalWorkspaceOpen" },
  { "key": "mod+1", "command": "terminal.workspace.terminal", "when": "terminalWorkspaceOpen" },
  { "key": "mod+2", "command": "terminal.workspace.chat", "when": "terminalWorkspaceOpen" },
  { "key": "mod+shift+b", "command": "browser.toggle", "when": "!terminalFocus" },
  { "key": "mod+d", "command": "diff.toggle", "when": "!terminalFocus" },
  { "key": "cmd+l", "command": "composer.focus.toggle", "when": "!terminalFocus" },
  { "key": "mod+shift+m", "command": "modelPicker.toggle", "when": "!terminalFocus" },
  { "key": "alt+]", "command": "model.next", "when": "!terminalFocus" },
  { "key": "alt+[", "command": "model.previous", "when": "!terminalFocus" },
  { "key": "mod+shift+e", "command": "traitsPicker.toggle", "when": "!terminalFocus" },
  { "key": "mod+shift+u", "command": "settings.usage", "when": "!terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus || isMac" },
  { "key": "mod+shift+n", "command": "chat.newLatestProject", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+n", "command": "chat.newChat", "when": "!terminalFocus || isMac" },
  { "key": "mod+shift+t", "command": "chat.newTerminal", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+c", "command": "chat.newClaude", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+x", "command": "chat.newCodex", "when": "!terminalFocus || isMac" },
  { "key": "mod+alt+r", "command": "chat.newCursor", "when": "!terminalFocus || isMac" },
  { "key": "mod+\\", "command": "chat.split", "when": "!terminalFocus || isMac" },
  { "key": "ctrl+tab", "command": "view.recent.next" },
  { "key": "ctrl+shift+tab", "command": "view.recent.previous" },
  { "key": "mod+1", "command": "thread.jump.1", "when": "!terminalFocus && !terminalWorkspaceOpen" },
  { "key": "mod+2", "command": "thread.jump.2", "when": "!terminalFocus && !terminalWorkspaceOpen" },
  { "key": "mod+3", "command": "thread.jump.3", "when": "!terminalFocus && !terminalWorkspaceOpen" },
  { "key": "mod+4", "command": "thread.jump.4", "when": "!terminalFocus && !terminalWorkspaceOpen" },
  { "key": "mod+5", "command": "thread.jump.5", "when": "!terminalFocus && !terminalWorkspaceOpen" },
  { "key": "mod+6", "command": "thread.jump.6", "when": "!terminalFocus && !terminalWorkspaceOpen" },
  { "key": "mod+7", "command": "thread.jump.7", "when": "!terminalFocus && !terminalWorkspaceOpen" },
  { "key": "mod+8", "command": "thread.jump.8", "when": "!terminalFocus && !terminalWorkspaceOpen" },
  { "key": "mod+9", "command": "thread.jump.9", "when": "!terminalFocus && !terminalWorkspaceOpen" },
  { "key": "mod+shift+]", "command": "chat.visible.next", "when": "!terminalFocus" },
  { "key": "mod+shift+[", "command": "chat.visible.previous", "when": "!terminalFocus" },
  { "key": "mod+o", "command": "editor.openFavorite" }
]
```

For most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts)

On startup the server backfills defaults for commands missing from your config file. A custom rule for a command replaces every default rule for that same command.

A few commands are not in the server defaults above and instead ship client-side fallbacks in [`DEFAULT_SHORTCUT_FALLBACKS` in `apps/web/src/keybindings.ts`](apps/web/src/keybindings.ts), which apply only while the command has no configured binding. `git.commitAndPush` is one of these: Cmd+Ctrl+P on macOS, Ctrl+Alt+P elsewhere.

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

Sidebar:

- `sidebar.toggle`: show/hide the sidebar
- `sidebar.search`: toggle the search palette
- `sidebar.addProject`: open the search palette in browse mode to add a project
- `sidebar.importThread`: toggle the search palette in import mode

Spaces:

- `space.next` / `space.previous`: switch to the next/previous project space and restore its last working context
- `space.jump.1` … `space.jump.9`: switch straight to the Nth tab of the space switcher. These address the switcher's visual tab order, so `space.jump.1` is always Void

Terminal:

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.splitRight` / `terminal.splitLeft` / `terminal.splitDown` / `terminal.splitUp`: split the focused terminal in a direction
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `terminal.workspace.newFullWidth`: open a new full-width terminal workspace
- `terminal.workspace.closeActive`: close the active terminal workspace
- `terminal.workspace.terminal` / `terminal.workspace.chat`: focus the terminal / chat pane of the terminal workspace

Panels and pickers:

- `browser.toggle`: toggle the embedded browser panel
- `diff.toggle`: toggle the diff panel
- `composer.focus.toggle`: focus or blur the chat prompt composer
- `modelPicker.toggle`: toggle the model picker
- `model.next` / `model.previous`: cycle models within the active provider (favorites first)
- `traitsPicker.toggle`: toggle the traits picker
- `settings.usage`: open Settings → Usage

New threads:

- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLatestProject`: create a new thread in the most recent usable project
- `chat.newChat`: create a new chat for the active surface
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `chat.newTerminal`: create a new terminal-first thread preserving the active thread's branch/worktree state
- `chat.newClaude` / `chat.newCodex` / `chat.newCursor`: create a new thread for that provider
- `chat.split`: split the active chat view

Navigation:

- `view.recent.next` / `view.recent.previous`: cycle through recently viewed threads
- `thread.jump.1` … `thread.jump.9`: jump to the Nth thread in the sidebar
- `chat.visible.next` / `chat.visible.previous`: switch to the next/previous visible chat

Other:

- `editor.openFavorite`: open current project/worktree in the last-used editor
- `git.commitAndPush`: commit pending changes and push the active thread's repo
- `script.{id}.run`: run a project script by id (for example `script.test.run`)

The authoritative command list is `STATIC_KEYBINDING_COMMANDS` in [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts).

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

### `when` Conditions

Currently available context keys:

- `terminalFocus`
- `terminalOpen`
- `terminalWorkspaceOpen`
- `isMac` (true when the app runs on macOS)

The literals `true` and `false` are also accepted.

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "terminalFocus || terminalOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
