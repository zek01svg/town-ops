FROM oven/bun:canary-slim AS runner
WORKDIR /app

COPY build ./build
# migrate.js applies pending migrations before the server starts
COPY src/database/drizzle ./src/database/drizzle

EXPOSE 5000
CMD ["sh", "-c", "bun build/database/migrate.js && bun build/index.js"]
