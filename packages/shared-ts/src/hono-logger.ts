import type { Context, Next } from "hono";

import { logger } from "./logger";

/**
 * Access logging middleware that records HTTP requests to Pino
 * and captures response times in milliseconds.
 */
export const honoLogger = () => {
  return async (c: Context, next: Next) => {
    const start = performance.now();
    await next();
    const ms = performance.now() - start;

    const status = c.res.status;
    const logData = {
      method: c.req.method,
      url: c.req.path,
      status,
      durationMs: parseFloat(ms.toFixed(2)),
    };

    if (status >= 500) {
      logger.error(logData, "HTTP Request Failed");
    } else if (status >= 400) {
      logger.warn(logData, "HTTP Request Warning");
    } else {
      logger.info(logData, "HTTP Request Success");
    }
  };
};
