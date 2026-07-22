import { timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

/**
 * Requires a Bearer token that exactly matches the shared Worker service
 * token, comparing bytes in constant time to avoid a timing side-channel.
 * Every atom's internal-only routes mount this ahead of their handlers.
 */
export function workerAuth(token: string): MiddlewareHandler {
  const expected = new TextEncoder().encode(token);

  return async (c, next) => {
    const authorization = c.req.header("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const received = new TextEncoder().encode(
      authorization.slice("Bearer ".length)
    );
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return next();
  };
}
