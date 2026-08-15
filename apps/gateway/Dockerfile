FROM node:24-bookworm-slim

WORKDIR /app
RUN npm install -g pnpm@next-12

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/gateway ./apps/gateway
COPY packages/orchestration-contract ./packages/orchestration-contract
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @townops/gateway...

# Runs node directly rather than `pnpm --filter @townops/gateway start`, which
# is the same command the start script holds. pnpm@12.0.0-rc.4 re-resolves the
# workspace before running a script and passes `--production` to its own
# internal install -- a flag pnpm 12 removed in favour of `--prod` -- so the
# container exits 2 before any app code runs, and Cloud Run reports only the
# generic "failed to start and listen on PORT". Keeping the package manager out
# of the runtime path removes the whole class of failure. See tasks/lessons.md:
# this is the third time pnpm@12.0.0-rc.4 has broken something.
CMD ["node", "--experimental-strip-types", "apps/gateway/src/index.ts"]
