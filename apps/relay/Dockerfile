# syntax=docker/dockerfile:1.7-labs
# Build from the repository root so Bun can resolve the complete workspace.
FROM oven/bun:1.3-slim AS deps
WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY patches patches
COPY --parents apps/*/package.json packages/*/package.json scripts/package.json ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/relay/node_modules apps/relay/node_modules
COPY --from=deps /app/packages/contracts/node_modules packages/contracts/node_modules
COPY --from=deps /app/packages/relay-protocol/node_modules packages/relay-protocol/node_modules
COPY package.json bun.lock ./
COPY packages/contracts packages/contracts
COPY packages/relay-protocol packages/relay-protocol
COPY apps/relay apps/relay

USER bun
EXPOSE 8789
CMD ["bun", "run", "--cwd", "apps/relay", "start"]
