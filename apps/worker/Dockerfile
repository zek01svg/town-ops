FROM node:24-bookworm-slim

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/worker ./apps/worker
COPY packages/orchestration-contract ./packages/orchestration-contract
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @townops/worker...

CMD ["pnpm", "--filter", "@townops/worker", "start"]
