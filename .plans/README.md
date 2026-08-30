# Maintainability Plans

This directory contains this index and the 29 plan artifacts below.
It is an inventory, not an execution queue: use [the numbered automation-plan
index](../plans/README.md) for that sequence and the [current evidence-backed
audit](../audit/PR357_MERGE_READINESS_AUDIT.md) for audit findings and
acceptance evidence.

| File | Plan |
| --- | --- |
| `01-shared-model-normalization.md` | Centralize Model Normalization in Contracts |
| `02-typed-ipc-boundaries.md` | Strengthen Typed IPC Boundaries in Main Process |
| `03-split-codex-app-server-manager.md` | Decompose CodexAppServerManager |
| `04-split-chatview-component.md` | Split ChatView into Smaller UI/Logic Units |
| `05-zod-persisted-state-validation.md` | Move Renderer Persisted-State Validation to Zod |
| `06-provider-logstream-lifecycle.md` | Add Provider Log Stream Lifecycle Management |
| `07-ci-quality-gates.md` | Add CI Workflow for Core Quality Gates |
| `08-precommit-format-and-lint.md` | Add Pre-Commit Formatting/Lint Hooks |
| `09-event-state-test-expansion.md` | Expand Event/State Transition Test Coverage |
| `10-unify-process-session-abstraction.md` | Unify Process and PTY Session Abstractions in ProcessManager |
| `11-effect.md` | Effect migration PR sequence |
| `12-effect-new.md` | Effect Migration Plan (From Current State) |
| `13-provider-service-integration-tests.md` | ProviderService Integration Test Plan |
| `14-server-authoritative-event-sourcing-cleanup.md` | Server-Authoritative Event-Sourcing Cleanup Plan |
| `15-effect-server.md` | Effect-native server entrypoint note |
| `16-pr89-review-remediation-phases.md` | PR #89 Review Remediation Plan (Phased) |
| `16c-pr89-remediation-checklist.md` | PR #89 Remediation Checklist (Consolidated) |
| `17-claude-agent.md` | Claude Code Integration (Orchestration Architecture) |
| `17-provider-neutral-runtime-determinism.md` | Provider-Neutral Runtime Determinism and Flake Elimination |
| `branch-environment-picker-in-chatview-input.md` | Branch/Environment Picker in ChatView Input |
| `git-flows-integration-tests.md` | Git Flows Integration Tests |
| `git-flows-test-plan.md` | Git Flows Test Plan |
| `git-integration-branch-picker-worktrees.md` | Git Integration: Branch Picker + Worktrees |
| `github-issues-prs-feature.md` | GitHub Issues & Pull Requests Integration |
| `profile-data-source-audit.md` | Profile stats data-source scoping audit |
| `profile-stats-codex-brief.md` | Profile-stats data layer hardening brief |
| `spec-1-1-cutover-plan.md` | Spec 1:1 Cutover Plan |
| `spec-contract-matrix.md` | SPEC Contract Matrix (Sections 7.1–7.4) |
| `SYN-47-synara-studio.md` | SYN-47 — Synara Studio implementation plan |
