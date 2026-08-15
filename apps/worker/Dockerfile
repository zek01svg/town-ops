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

CMD ["pnpm", "--filter", "@townops/worker", "start"]
