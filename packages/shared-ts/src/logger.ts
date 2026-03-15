import { context, trace } from "@opentelemetry/api";
import pino from "pino";

import { env } from "./env";

/**
 * Shared Pino logger instance for TS services.
 * Automatically injects OpenTelemetry traceId and spanId if an active span is found,
 * making it fully compatible with Tempo/Jaeger tracing correlating logs & traces.
 */
export const logger = pino({
  level: "info",
  mixin() {
    const span = trace.getSpan(context.active());
    if (span) {
      const { traceId, spanId } = span.spanContext();
      return { traceId, spanId };
    }
    return {};
  },
  transport:
    env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname",
          },
        }
      : undefined,
});
