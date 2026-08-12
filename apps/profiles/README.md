# @synara/profiles

The public profile pages — `trysynara.com/@handle`.

A deliberately tiny Next.js app: one dynamic route that server-renders a
profile from the account service's public JSON endpoint
(`GET /api/v1/profiles/:handle`). No client-side data fetching, no auth, no
state — the page must unfurl in link previews and paint without hydration.

## How it is reached

`trysynara.com` stays pointed at the marketing site's Vercel project. That
project carries one rewrite:

```json
{
  "rewrites": [{ "source": "/@:handle", "destination": "https://<this-app>.vercel.app/@:handle" }]
}
```

so `/@dylan` proxies here while every other path stays marketing. This is the
domain's routing seam: future sub-apps (a hosted web app, say) get their own
rewrite the same way, and because rewrites can target any origin, a future
Railway-hosted app slots in identically.

The dynamic segment arrives URL-encoded (`%40dylan`); the page refuses
anything without the `@` and anything that is not a well-formed handle, so
this app never serves content on paths the rewrite did not intend.

## Environment

| Variable          | Default                        | Purpose                           |
| ----------------- | ------------------------------ | --------------------------------- |
| `ACCOUNT_API_URL` | `https://api.synara.vrbty.dev` | The account service to read from. |

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
