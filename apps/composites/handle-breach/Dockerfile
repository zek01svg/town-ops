FROM oven/bun:canary-slim
WORKDIR /app

COPY build ./build
EXPOSE 6005
CMD ["bun", "run", "build/index.js"]
