# Remote Projects over SSH

Run the coding agent on another machine while Synara's UI stays where it is. This replaces
the usual `ssh box` → `tmux` → `claude` loop with a normal Synara project: the same chat,
approvals, checkpoints, and subagent views, with the agent's process, filesystem, and shell
all on the host.

Supported for the **Claude** provider. Other providers still run locally; a thread in a
remote project refuses to start on them rather than silently running against a path that
does not exist on this machine.

## Add a remote project

1. **Add project** in the sidebar.
2. Set **Location** to **Remote over SSH**.
3. **Path** — the project folder as it exists _on the host_, e.g. `/srv/app`.
4. **SSH host** — any ssh(1) destination: `deploy@build-box`, `10.0.0.5`, or a
   `~/.ssh/config` `Host` alias.

That is the whole required setup when your host is already in `~/.ssh/config`. Synara shells
out to `ssh`, so your existing port, identity, `ProxyJump`, `ProxyCommand`, and
`ControlMaster` settings apply unchanged, and agent forwarding keeps working.

## Advanced

Three optional fields cover hosts that need more than an alias:

| Field                     | Use it for                                                       | Example                               |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| Extra ssh arguments       | Connections you do not keep in `~/.ssh/config`                   | `-p 2222 -i ~/.ssh/deploy -J bastion` |
| Shell setup               | Non-login shells that need a version manager or exported secrets | `source ~/.nvm/nvm.sh`                |
| Claude binary on the host | A `claude` that is not on the non-interactive `PATH`             | `/usr/local/bin/claude`               |

Extra ssh arguments are placed **before** Synara's own options, and ssh keeps the first
value it sees for an option — so anything you set here wins over Synara's defaults
(`ServerAliveInterval=30`, `ServerAliveCountMax=3`).

## What actually runs

For each session Synara builds one command:

```
ssh -T <your ssh args> -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    [-R <gateway port>:127.0.0.1:<gateway port>] <host> \
    'cd <path> && <shell setup> && exec env CLAUDE_CODE_ENTRYPOINT=sdk-ts <claude> <cli flags>'
```

- The CLI's own argv is unchanged — only _where_ it runs differs — so the Claude Agent SDK
  keeps speaking its normal stdio protocol, now over the ssh connection.
- `-T` keeps the connection free of a pty, which would otherwise echo and rewrap the
  protocol's JSON.
- Every path and argument is single-quoted before it reaches the remote shell.
- `-R` forwards the loopback port serving Synara's `synara_*` MCP tools, using the same port
  number on both ends so the agent's endpoint URL resolves on either side.

## Environment and credentials

Synara forwards **no** local environment to the host. Your local `PATH`, `CLAUDE_CONFIG_DIR`,
and API keys describe this machine, and shipping them across would be both wrong and
careless with secrets.

The host authenticates the agent exactly as it does when you run `claude` there by hand — its
own `~/.claude` credentials or its own exported `ANTHROPIC_API_KEY`. If those only exist in an
interactive profile, put the export in **Shell setup**.

Synara never stores an SSH password or key: authentication is entirely `ssh`'s, using your
agent, keys, and config.

## Requirements on the host

- `claude` installed and runnable non-interactively (`ssh <host> claude --version` should work).
- The project path exists. Synara does not create remote directories.
- Key-based or agent-based auth. A spawn with no tty cannot answer a password prompt.

## Current limits

A remote project is a chat-and-agent surface today. These stay local-only for now:

- Worktrees — the environment picker offers only the remote host; git worktrees are created
  on the server's own filesystem.
- Dev servers, the file tree, diff/checkpoint views, and "Open in Finder/editor", which all
  read this machine's filesystem.
- Native slash-command discovery before the first turn. Once a session is running the
  commands come from the live remote CLI.
