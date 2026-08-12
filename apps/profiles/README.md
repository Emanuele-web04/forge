# @synara/profiles

The public profile pages — `trysynara.com/@handle`.

A deliberately tiny Next.js app: one dynamic route that server-renders a
profile from the account service's public JSON endpoint
(`GET /api/v1/profiles/:handle`). No client-side data fetching, no auth, no
state — the page must unfurl in link previews and paint without hydration.

## How it is reached

`trysynara.com` stays pointed at the marketing site's Vercel project. That
project carries two rewrites:

```json
{
  "rewrites": [
    { "source": "/@:handle", "destination": "https://<this-app>.vercel.app/@:handle" },
    { "source": "/profiles-assets/:path*", "destination": "https://<this-app>.vercel.app/:path*" }
  ]
}
```

so `/@dylan` proxies here while every other path stays marketing. This is the
domain's routing seam: future sub-apps (a hosted web app, say) get their own
rewrite the same way, and because rewrites can target any origin, a future
Railway-hosted app slots in identically.

The second rewrite exists because only the `/@handle` _document_ is proxied:
this app's root-relative `/_next/static` asset URLs would otherwise resolve
against the marketing deployment and 404 (no CSS/JS). Production therefore
sets `PROFILES_ASSET_PREFIX` (below) so assets are requested under
`/profiles-assets/…`, which the rewrite routes back to this deployment.

The dynamic segment arrives URL-encoded (`%40dylan`); the page refuses
anything without the `@` and anything that is not a well-formed handle, so
this app never serves content on paths the rewrite did not intend.

## Environment

| Variable                | Default                        | Purpose                                                                                                                                                  |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCOUNT_API_URL`       | `https://api.synara.vrbty.dev` | The account service to read from.                                                                                                                        |
| `PROFILE_PROXY_SECRET`  | unset                          | Shared secret (same value as the API's `PROFILE_PROXY_SECRET`) that lets the API rate-limit per visitor instead of per egress IP. Keying only, not auth. |
| `PROFILES_ASSET_PREFIX` | unset                          | Asset prefix for the production split-domain deploy, e.g. `https://trysynara.com/profiles-assets`. Leave unset in dev — unset changes nothing.           |

Profiles are served only when their owner made them public; a 404 covers
unknown and private handles indistinguishably, and the page mirrors that
ambiguity.

## Develop

```sh
bun run --cwd apps/profiles dev        # http://localhost:4321/@somehandle
```

Point `ACCOUNT_API_URL` at a local API for offline work.

## Deploy

Its own Vercel project, root directory `apps/profiles`, default Next.js
build. Set `ACCOUNT_API_URL` if the account service ever moves.

Production must also set:

- `PROFILES_ASSET_PREFIX` (e.g. `https://trysynara.com/profiles-assets`), and
  the marketing project needs the matching `/profiles-assets/:path*` rewrite —
  without both, proxied profile pages render with no CSS/JS.
- `PROFILE_PROXY_SECRET`, mirrored into the API's Railway environment, so
  visitor traffic gets per-viewer rate-limit buckets instead of one shared
  budget for this deployment's egress IP.
