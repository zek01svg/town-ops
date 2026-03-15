import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const env = createEnv({
  server: {
    PORT: z.coerce.number().default(5001),
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string(),
    OTEL_EXPORTER_OTLP_HEADERS: z.string(),
  },
  runtimeEnv: {
    PORT: Number(process.env.PORT),
    NODE_ENV: process.env.NODE_ENV,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
  },
  skipValidation: process.env.npm_lifecycle_event === 'lint',
}) as unknown as {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  OTEL_EXPORTER_OTLP_ENDPOINT: string;
  OTEL_EXPORTER_OTLP_HEADERS: string;
};
