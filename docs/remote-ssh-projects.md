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

5. **Check connection**, then **Create project**.

That is the whole required setup when your host is already in `~/.ssh/config`. Synara shells
out to `ssh`, so your existing port, identity, `ProxyJump`, `ProxyCommand`, and
`ControlMaster` settings apply unchanged, and agent forwarding keeps working.

## Check connection

The button runs the command a real session would run — same ssh options, same launcher, same
working directory, same quoting — with `claude --version` in place of a turn. A check that
passes cannot be passing for a different command than the one that will run.

| What it finds                              | What you see                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| ssh could not get a shell                  | ssh's own stderr: wrong key, unknown host, no route                                    |
| The path is not there                      | the path, named                                                                        |
| `claude` is not on the connection's `PATH` | it retries through a login shell, and if that works, **switches the launcher for you** |
| The shell prints before the agent runs     | a warning — that output lands inside the agent protocol and corrupts the session       |
| Everything works                           | the version the host reported                                                          |

It runs with `BatchMode=yes` so a host that wants a password fails immediately with that as
the reason, rather than hanging on a prompt no one can answer. Real sessions keep ssh's
normal interactive behaviour.

Editing any field discards the result, so a green check always describes what the form
currently says.

### Multiple threads on one host

Each thread opens its own ssh connection and runs its own agent, in parallel. Add
connection reuse so that stays cheap:

```
Host <your host>
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

Without it every thread pays a full TCP and auth handshake. With it they share one
connection, and the host sees one login instead of N. Past roughly ten concurrent threads,
raise `MaxSessions` in the host's `sshd_config` — that is the multiplexed-channel cap.

## Where the agent lands

**Run the agent through** (in Advanced) decides what the agent command runs inside on the
host. Every option hands the same project script — `cd <path> && <shell setup> && exec <claude>` —
to a different shell, so the script's meaning never changes; only what opens that shell does.

| Option           | Runs                                          | Use it for                                                                                                                  |
| ---------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Directly         | `<claude>`                                    | Default. The host's non-interactive environment already works.                                                              |
| A login shell    | `bash -l -c '<script>'`                       | nvm, mise, asdf, rbenv, Herd — anything that only exists once a profile is sourced. Shell is configurable.                  |
| A container      | `docker exec -i <container> sh -c '<script>'` | Dockerized dev environments. Supports `docker`, `podman`, and `docker compose exec -T`, plus an optional user.              |
| A custom command | `<your command> sh -c '<script>'`             | Everything else that runs in place: `mise exec --`, `nix develop -c`, `direnv exec .`, `distrobox enter --`, `toolbox run`. |

The container option is typed rather than left to the custom field because the interactive
flag is what keeps stdin open — `exec -i`, or `-T` for compose. Omitting it produces a
session that connects and then silently never answers, which is the least debuggable
failure this feature can have.

### Why tmux is not an option

Terminal multiplexers are refused, with the reason shown next to the field.

The agent speaks newline-delimited JSON on the stdin and stdout it inherits from ssh. tmux,
screen, and zellij all run their command in a separate server process on a **new pty**:

- `tmux new-session -d '<claude>'` — the pane does not inherit Synara's stdin/stdout, and the
  ssh command returns immediately, so the session is over before the first frame.
- `tmux new-session` without `-d` over `ssh -T` — "open terminal failed: not a terminal".
- `ssh -t` plus tmux — the protocol goes through a pty _and_ tmux's terminal emulation, so it
  arrives echoed, wrapped at the pane width, and interleaved with escape sequences.

`nohup`, `setsid`, and `-d`/`--detach` flags are refused for the same reason: they detach the
process Synara needs to stay attached to.

The persistence tmux normally provides is already covered — a Synara thread outlives the ssh
connection and resumes the provider session, so a dropped link is not a lost conversation.
If you want a shell on the host alongside the agent, open one the way you always have; it is
simply not where the agent lives.

## Advanced

Three more optional fields cover hosts that need more than an alias:

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
    '<launcher> cd <path> && <shell setup> && exec env CLAUDE_CODE_ENTRYPOINT=sdk-ts <claude> <cli flags>'
```

With a launcher configured, the part after `<launcher>` is quoted and handed to it as one
argument — for a login shell that is `exec bash -l -c '<script>'`.

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
- Editing a project's remote settings after creation. The command exists server-side; there
  is no UI for it yet, so a change means re-adding the project.
