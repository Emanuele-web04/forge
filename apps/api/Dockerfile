# syntax=docker/dockerfile:1.7-labs
# Synara account API. Build context is the repository root so the Bun
# workspace graph (root package.json + bun.lock + workspace packages) resolves;
# point the builder at this file with dockerfilePath=apps/api/Dockerfile.
FROM oven/bun:1.3-slim AS deps
WORKDIR /app

# Workspace manifests only, so dependency installation caches independently of
# source changes. apps/api runs from TypeScript source under Bun — no build step.
#
# The manifest set is materialized by a glob COPY: --frozen-lockfile refuses a
# lockfile naming ANY workspace absent from the build context, so a hand-kept
# list breaks the deploy every time a workspace package is added (it did,
# three times). --parents preserves each manifest's directory (the dockerfile:1.7-labs
# syntax directive above enables it; BuildKit honours the directive).
COPY package.json bun.lock turbo.json ./
COPY patches patches
COPY --parents apps/*/package.json packages/*/package.json scripts/package.json ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules node_modules
# Bun installs workspace-scoped dependencies into per-package node_modules;
# the root copy alone leaves runtime imports (e.g. @hono/node-server) unresolved.
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=deps /app/packages/contracts/node_modules packages/contracts/node_modules
COPY --from=deps /app/packages/shared/node_modules packages/shared/node_modules
COPY package.json bun.lock ./
COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
COPY apps/api apps/api

USER bun
EXPOSE 8788
CMD ["bun", "run", "--cwd", "apps/api", "start"]
