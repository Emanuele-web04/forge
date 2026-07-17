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
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+o", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "chat.newLocal", "when": "!terminalFocus" },
  { "key": "mod+shift+t", "command": "chat.newTerminal", "when": "!terminalFocus" },
  { "key": "cmd+l", "command": "composer.focus.toggle", "when": "!terminalFocus" },
  { "key": "mod+enter", "command": "thread.approval.accept", "when": "!terminalFocus || isMac" },
  {
    "key": "mod+shift+enter",
    "command": "thread.approval.acceptForSession",
    "when": "!terminalFocus || isMac"
  },
  {
    "key": "mod+backspace",
    "command": "thread.approval.decline",
    "when": "!terminalFocus || isMac"
  },
  { "key": "mod+shift+p", "command": "thread.planMode.toggle", "when": "!terminalFocus || isMac" },
  { "key": "mod+shift+f", "command": "thread.fastMode.toggle", "when": "!terminalFocus || isMac" },
  { "key": "alt+shift+]", "command": "thread.effort.next", "when": "!terminalFocus" },
  { "key": "alt+shift+[", "command": "thread.effort.previous", "when": "!terminalFocus" },
  {
    "key": "mod+shift+d",
    "command": "composer.dictation.toggle",
    "when": "!terminalFocus || isMac"
  },
  { "key": "mod+o", "command": "editor.openFavorite" },
  { "key": "cmd+[", "command": "history.back", "when": "isElectron" },
  { "key": "cmd+]", "command": "history.forward", "when": "isElectron" },
  {
    "key": "alt+arrowleft",
    "command": "history.back",
    "when": "isElectron && !isMac && !terminalFocus"
  },
  {
    "key": "alt+arrowright",
    "command": "history.forward",
    "when": "isElectron && !isMac && !terminalFocus"
  }
]
```

For most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts)

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `chat.newTerminal`: create a new terminal-first thread preserving the active thread's branch/worktree state
- `composer.focus.toggle`: focus or blur the chat prompt composer
- `composer.send`: send the composer contents to the active thread (no default binding)
- `composer.dictation.toggle`: start or stop voice dictation in the composer
- `thread.approval.accept`: accept the pending approval request in the active thread
- `thread.approval.acceptForSession`: accept the pending approval request for the rest of the session
- `thread.approval.decline`: decline the pending approval request in the active thread
- `thread.planMode.toggle`: switch the composer between plan mode and the default interaction mode
- `thread.fastMode.toggle`: enable/disable fast mode when the selected model supports it
- `thread.effort.next` / `thread.effort.previous`: cycle the reasoning effort level for the selected model
- `thread.fork`: fork the current thread from its latest state (no default binding)
- `history.back` / `history.forward`: navigate the in-app view history (desktop app)
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `script.{id}.run`: run a project script by id (for example `script.test.run`)

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
- `isElectron` (true when running in the Synara desktop app)

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
