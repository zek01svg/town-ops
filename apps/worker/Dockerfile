FROM node:24-bookworm-slim

WORKDIR /app
RUN npm install -g pnpm@next-12

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/worker ./apps/worker
COPY packages/orchestration-contract ./packages/orchestration-contract
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @townops/worker...

# Below the install so the build identity never busts the dependency layer cache.
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID

# Runs node directly, for the reason spelled out in apps/gateway/Dockerfile:
# pnpm@12.0.0-rc.4 passes the removed `--production` flag to its own internal
# install before running a workspace script, so the container exits 2. The
# Worker Pool has no HTTP health check, so this failed silently here rather
# than failing the deploy -- it would have looked like a Worker that never
# polls Temporal.
CMD ["node", "--experimental-strip-types", "apps/worker/src/index.ts"]
