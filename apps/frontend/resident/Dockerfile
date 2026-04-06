FROM oven/bun:canary-slim AS runner
WORKDIR /app

COPY build ./build

EXPOSE 3000
CMD ["bun", "build/index.js"]
