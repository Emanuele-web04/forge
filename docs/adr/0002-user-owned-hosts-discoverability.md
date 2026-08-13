# Hosts are user-owned; discoverability is the single sharing switch

Hosts belong to the user who registered them, not the org — the org is tenancy. Each host has an owner-controlled discoverability toggle: off means only the owner sees it; on means the entire org both sees and can use it (open sessions, run agents). Visibility and usability are deliberately the same switch — no per-user grants, no "visible but not usable" state.

Discoverability defaults to **on** at registration: frictionless for solo users (personal org) and trusting teams; owners opt out for private machines. One guard: because Desktop auto-registers its bundled host at sign-in (ADR 0015), the first sign-in into a **multi-member** org prompts "share this machine with <org>?" — explicit consent before a laptop silently grants the org code execution. Personal orgs never prompt.

This replaces the earlier org-only authorization (`ownerOrgId` as the sole key with `registeredByUserId` as audit) and requires the account API's hosts table and route authorization to become owner-aware. We accepted the coarse granularity: a host that hands out code execution is either private or trusted to the whole org, and orgs are assumed to be trust boundaries.

Lifecycle consequence: the host follows the owner. Leaving the org removes the host from the org's directory (members' sessions end on next reconnect); account deletion revokes the host token. Orgs never own machines, so there is no transfer/reassignment flow.
