import type { Context } from "hono";
import * as Sentry from "@sentry/bun";

type SentryInitOptions = {
  serviceName?: string;
  dsn?: string;
  environment?: string;
  release?: string;
  tracesSampleRate?: number;
};

type CaptureOptions = {
  serviceName?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  request?: {
    method?: string;
    path?: string;
    url?: string;
    userAgent?: string;
  };
};

let initialized = false;

function parseSampleRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const rate = Number.parseFloat(value);
  if (!Number.isFinite(rate)) return undefined;
  return Math.min(Math.max(rate, 0), 1);
}

export function initSentry(options: SentryInitOptions = {}) {
  if (initialized) return;

  const dsn = options.dsn ?? process.env.SENTRY_DSN ?? process.env.SENTRY_BACKEND_DSN;
  if (!dsn) return;

  const tracesSampleRate =
    options.tracesSampleRate ??
    parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE) ??
    0;

  Sentry.init({
    dsn,
    environment: options.environment ?? process.env.SENTRY_ENVIRONMENT,
    release: options.release ?? process.env.SENTRY_RELEASE,
    tracesSampleRate,
  });

  if (options.serviceName) {
    Sentry.setTag("service", options.serviceName);
  }

  initialized = true;
}

export function captureException(err: unknown, options: CaptureOptions = {}) {
  if (!initialized) return;

  Sentry.withScope((scope) => {
    if (options.serviceName) {
      scope.setTag("service", options.serviceName);
    }
    if (options.tags) {
      Object.entries(options.tags).forEach(([key, value]) => {
        scope.setTag(key, value);
      });
    }
    if (options.request) {
      scope.setContext("request", options.request);
    }
    if (options.extra) {
      scope.setContext("extra", options.extra);
    }
    Sentry.captureException(err);
  });
}

export function captureHonoException(err: unknown, c: Context) {
  if (!initialized) return;

  captureException(err, {
    request: {
      method: c.req.method,
      path: c.req.path,
      url: c.req.url,
      userAgent: c.req.header("user-agent") ?? undefined,
    },
  });
}
