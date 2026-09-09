# CORTEX Cloud Control Plane

This is a new, independently deployable Cloud boundary. It is **not** imported by or a
replacement for the local-first `apps/server` runtime.

## Current capability

- `GET /healthz` returns process liveness.
- `GET /readyz` verifies PostgreSQL connectivity.
- `/v1/*` fails closed with `503 cloud_auth_not_configured` until cloud identity and
  transaction-scoped tenant context are implemented.
- `migrations/0004_api_tokens.sql` adds storage for hashed CORTEX API-token metadata;
  it does not expose token-management endpoints yet.

This deliberate state prevents an unauthenticated caller from creating, listing, or
validating API tokens before the P0 cloud-authentication boundary exists.

## Local startup

```console
CORTEX_DATABASE_URL=postgresql://app:password@127.0.0.1:5432/cortex \
  bun run --cwd apps/cloud-control dev
```

Configuration is fail-fast:

| Variable              | Required | Meaning                                                                          |
| --------------------- | -------- | -------------------------------------------------------------------------------- |
| `CORTEX_DATABASE_URL` | yes      | PostgreSQL application-role URL. Never use the migration owner for HTTP traffic. |
| `PORT`                | no       | Listener port; defaults to `8787`.                                               |
| `HOST`                | no       | Listener host; defaults to `0.0.0.0`.                                            |
| `CORTEX_ENVIRONMENT`  | no       | `development`, `staging`, or `production`; defaults to `development`.            |

## Token-security contract

The control plane will generate `ctx_live_…` tokens with a cryptographic RNG, display
the raw secret once in the create response, store only a domain-separated SHA-256 digest
and prefix, compare candidate digests in constant time, and enforce expiry, revocation,
organization context, and scopes server-side. Raw tokens must never appear in logs,
telemetry, audit metadata, browser storage, token lists, or token-detail responses.

Do not add a `/v1/ai/*` handler until the identity, tenant transaction, API-token
authentication, quota, audit, and execution-plane boundaries described in
[`../../audit/PLATFORM_READINESS_AUDIT.md`](../../audit/PLATFORM_READINESS_AUDIT.md) are
implemented and tested.
