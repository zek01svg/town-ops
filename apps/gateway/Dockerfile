FROM node:24-bookworm-slim

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/gateway ./apps/gateway
COPY packages/orchestration-contract ./packages/orchestration-contract
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @townops/gateway...

CMD ["pnpm", "--filter", "@townops/gateway", "start"]
