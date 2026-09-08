FROM oven/bun:1.4.2-alpine

WORKDIR /app

COPY apps/cloud-control/package.json ./package.json
COPY apps/cloud-control/tsconfig.json ./tsconfig.json
COPY apps/cloud-control/src ./src

ENV NODE_ENV=production
ENV HOST=0.0.0.0

EXPOSE 10000

CMD ["bun", "run", "start"]
