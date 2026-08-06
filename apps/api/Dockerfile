# Synara account API. Build context is the repository root so the Bun
# workspace graph (root package.json + bun.lock + workspace packages) resolves;
# point the builder at this file with dockerfilePath=apps/api/Dockerfile.
FROM oven/bun:1.3-slim AS deps
WORKDIR /app

# Workspace manifests only, so dependency installation caches independently of
# source changes. apps/api runs from TypeScript source under Bun — no build step.
COPY package.json bun.lock turbo.json ./
COPY patches patches
COPY apps/api/package.json apps/api/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/marketing/package.json apps/marketing/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY scripts/package.json scripts/package.json
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules node_modules
COPY package.json bun.lock ./
COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
COPY apps/api apps/api

EXPOSE 8788
CMD ["bun", "run", "--cwd", "apps/api", "start"]
