# Forkara

> [!IMPORTANT]
> Forkara was built completely from the ground up.
>
> We simply started by cloning another repository, preserving 100% of its commit history, and then rebuilt everything from scratch one commit at a time.
>
> Totally different.

Forkara is now an MCP-native **fork harness** in two directions: supported agents running inside Forkara
automatically receive tools to coordinate upstream merges and attribution, while Codex, Claude, and
other local MCP clients can connect through a scoped integration to launch and follow Forkara work.

To let a local MCP-capable app create and follow scoped Forkara tasks, see
[External MCP integrations](docs/external-mcp.md).

Forkara is a local-first desktop app for coding with the AI agents and repositories you already fork.

It brings chats, terminals, browser previews, diffs, branches, commit history, provider sessions, and handoffs into one focused workspace so you can run agent work without juggling a dozen windows or pretending Git history doesn't exist.

![Forkara app showing parallel forks, preserved commit history, and a healthy respect for upstream](assets/prod/readme-screenshot.jpeg)

---

## What it does

- Use the AI accounts you already pay for: Claude Code, Codex, Antigravity, OpenCode, Cursor, Grok, Kilo Code, and Pi.
- Run parallel work across projects, forks, and isolated Git worktrees without branches stepping on each other.
- Keep split chats, terminals, browser previews, and upstream commits visible in the same window.
- Hand off a thread to another provider while preserving context **and** attribution.
- Review diffs, create branches, commit, push, and open PRs from the app.
- Keep your workspace local. Forkara stores chats, projects, history, **and history history** on your machine.

---

## How to use

> [!WARNING]
> You need to have Git installed.
>
> Specifically:
>
> ```sh
> git clone
> ```
>
> This is considered **building from the ground up**.

Install the desktop app from the Releases page, or simply fork this repository and explain on Twitter why it isn't a fork.

You can also run Forkara locally while the project is still early:

```sh
git clone https://github.com/yourname/forkara
cd forkara

bun install
bun run dev
```

---

## Privacy

Forkara runs as the workspace layer on your machine.

There is no Forkara cloud holding your repositories, chats, or project history.

Unlike your commit history, nothing mysteriously disappears.

---

## Some notes

Forkara is still very early.

Expect bugs, rough edges, and fast moving internals.

Focused issues and PRs are welcome, especially bug fixes, reliability fixes, and small maintenance improvements.

Please keep copyright notices intact.

They're surprisingly lightweight.

---

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support?

Open a GitHub issue, fork the project, or simply declare your fork to be an entirely original invention.

---

## About Forks

Forkara proudly supports every kind of fork:

- 🍴 Git forks
- 🍽️ Dinner forks
- 🎵 Tuning forks
- 🔥 Pitchforks (for Twitter discourse only)

## Fork Glossary

- **Git fork**: A real Git hosting term for a copy of a repository under another account or organization, usually used to propose changes back upstream.
- **Clone**: A real Git term for a local copy of a repository; Forkara strongly respects the difference while making jokes about it anyway.
- **Dinner fork**: A parody fork used for moving food from plate to mouth, with no known pull request workflow.
- **Tuning fork**: A parody fork that produces a pitch when struck, useful for finding the right note and not for resolving merge conflicts.
- **Pitchfork**: A parody fork for hay, mobs, and dramatic project governance discussions.
- **Spork**: A parody hybrid fork-spoon that Forkara lists on the roadmap because some forks refuse to pick one abstraction.
- **Chess fork**: A real chess tactic where one piece attacks multiple targets; in Forkara terms, it is the board-game cousin of parallel worktrees.
- **Process fork**: A real operating-system term for creating a new process from an existing one, which is much closer to copying than cutlery.

---

## Philosophy

Forkara believes every great project deserves:

- a new logo
- a new README
- a new color palette
- preserved attribution
- fewer arguments about what `git clone` means

---

## Roadmap

- [x] Fork repository
- [x] Keep commit history
- [x] Rename project
- [x] Replace branding
- [x] Add increasingly elaborate explanations of why this isn't a fork
- [ ] Spork support
- [ ] Dishwasher-safe releases
- [ ] Stainless steel edition

---

## FAQ

### Is Forkara a fork?

Legally: yes.

Technically: yes.

Culinarily: also yes.

### Was Forkara built from the ground up?

Absolutely.

The ground just happened to contain:

```sh
git clone
```

### Why is it called Forkara?

Because Cloneara sounded too honest.

### How long does a fresh fork lifecycle usually take?

Enough time for exactly one coffee and one suspiciously calm compile.

### Why does that long-running timer mention 42 minutes?

It is only a metaphor for persistence.

### Can Forkara help with non-code forks?

Yes. If the fork has a clear owner and a clear next step, we can still model it in our glossary.

### What is the difference between a Git fork and a dinner fork?

A Git fork tracks history and intent; a dinner fork tracks dinner and intent is still optional.

### Do you support pitchforks?

They are useful for discussions that escalate quickly, and not required for code review.

### Are sporks officially supported?

Not yet. Sporks are in the roadmap, and we keep promises in the issue tracker before the kitchen.

---

## Origins

Forkara began as a fork of Synara.

Synara began as a clone of T3Code.

Forkara began as a fork of a clone that wasn't a fork because it was a clone.

Simple.

Today Forkara has evolved into a substantially different fork with its own branding, packaging, release system, provider orchestration, desktop app behavior, README, and an increasingly sophisticated explanation of what **"built from the ground up"** means.

Unlike disposable forks, we preserve our history.

---

> Made with ❤️, Git, and 18/10 stainless steel.
