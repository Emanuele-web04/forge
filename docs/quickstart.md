# Quickstart

This guide takes you through Synara's basic loop: open a repository, give one coding agent a
concrete task, supervise the work, and review the resulting diff. You should be up and running in
about five minutes.

> **Before you begin:** install Synara and authenticate at least one supported provider. In
> shortcuts, `mod` means Command on macOS and Ctrl on Windows or Linux.

## 1. Add a Git project

Open Synara and add a local repository.

Start with a repository whose current changes are already committed or intentionally preserved. A
clean starting state makes the agent's work much easier to review.

## 2. Create one task

Press `mod+n` or use the new-task control.

For this first task, use the local checkout and run only one agent against the repository. Use a
[Git worktree](https://www.trysynara.com/docs/workflows/worktrees) when you begin running multiple
tasks or want stronger isolation.

## 3. Choose a provider and model

Select an available provider, model, and effort or reasoning option.

Synara uses the provider runtime and account configured on your machine. It does not add a separate
Synara model plan.

## 4. Give the agent a verifiable objective

Describe:

- The outcome you want
- The files or area involved
- Important constraints
- The checks that should pass

For example:

```text
Add an empty state to the pull-request list.

Reuse the existing shared panel components.
Do not redesign the surrounding page.
Run the focused browser test and report the result.
```

A bounded objective is easier to execute, review, and undo than "improve the pull-request page."

## 5. Supervise the turn

Follow the transcript and tool activity while the provider works.

Useful controls:

- `mod+j` opens the terminal drawer.
- `mod+d` opens the diff view.
- `mod+shift+b` opens the browser.
- Approval and user-input requests appear in the task.
- Send a follow-up when the agent needs a correction or additional constraint.
- Interrupt the turn when it is clearly heading in the wrong direction.

Do not wait passively for a final message if the intermediate work is already incorrect.

## 6. Verify the result yourself

When the turn finishes:

1. Read the agent's summary.
2. Inspect the complete diff.
3. Run the relevant tests or checks yourself.
4. Look for unrelated files, debug output, generated artifacts, or accidental deletions.
5. Keep only the changes you understand and intend to ship.

The agent's final message is a report, not proof that the work is correct.

## 7. Commit or continue to a pull request

Commit the reviewed changes when they are ready.

For GitHub repositories, push the branch, inspect the final change set, and open a PR.

That is Synara's core workflow:

> Give one task a concrete objective, supervise the work, verify the result, and commit only what
> you intend to keep.

## Continue learning

- [Core concepts](https://www.trysynara.com/docs/getting-started/core-concepts) — projects, tasks,
  environments, provider sessions, and Git ownership.
- [Your first task](https://www.trysynara.com/docs/getting-started/first-task) — the same workflow
  in more detail, including recovery and review.
- [Best practices](https://www.trysynara.com/docs/workflows/best-practices) — patterns Synara
  maintainers rely on for real development work.
