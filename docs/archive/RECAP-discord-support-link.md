# Recap: Support Link Cleanup

> Generated: 2026-07-13 | Scope: 3 files

---

## Summary

The public support links now direct Synara users to the project's GitHub Issues page, the active support surface for questions and bug reports.

---

## Files Affected

| File                                         | Status      | Role                                                           |
| -------------------------------------------- | ----------- | -------------------------------------------------------------- |
| `README.md`                                  | ✏️ Modified | Replaces the incorrect Discord support link with GitHub Issues |
| `apps/marketing/src/layouts/Layout.astro`    | ✏️ Modified | Replaces the website footer's Discord link with an Issues link |
| `docs/archive/RECAP-discord-support-link.md` | ✅ Created  | Documents the support-link correction                          |

---

## Logic Explanation

### Problem

Both public support links pointed to an unowned destination. Presenting that destination as Synara support was misleading.

### Approach

The links were replaced with the repository's GitHub Issues page because Issues is enabled, active, and already part of Synara's contribution workflow. The marketing footer derives the destination from the existing `REPO_URL` constant so the repository address remains centralized.

### Step-by-step

1. A user looking for help in `README.md` is invited to open a GitHub issue.
2. A visitor selecting `Issues` in the marketing footer is sent to the same repository support page.
3. Neither public entry point references the unrelated Discord server anymore.

### Tradeoffs & Edge Cases

GitHub Issues is less conversational than chat, but it is the verified Synara-owned support surface currently available.

---

## Flow Diagram

### Happy Path

```mermaid
flowchart TD
    A[User needs Synara support] -->|README support link| B[GitHub Issues]
    A -->|Marketing footer Issues link| B
    B -->|Creates or reads an issue| C[Synara repository support]
```

---

## High School Explanation

The old support sign pointed to the wrong place. We changed both signs so they now point to Synara's own GitHub Issues page, where users can report a problem or ask for help.
