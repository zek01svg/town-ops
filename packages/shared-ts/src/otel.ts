import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { env } from "./env";
import { logger } from "./logger";

/**
 * Initializes OpenTelemetry tracing for Node.js/Bun services.
 * @param serviceName The name of the service for tracing.
 */
export function setupTracingTS(serviceName: string) {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headers = env.OTEL_EXPORTER_OTLP_HEADERS;

  if (!endpoint || !headers) {
    logger.warn(
      `OpenTelemetry: OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_HEADERS not set for ${serviceName}. Tracing disabled.`
    );
    return;
  }

  const traceUrl = endpoint.endsWith("/")
    ? `${endpoint}v1/traces`
    : `${endpoint}/v1/traces`;

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      "deployment.environment": env.NODE_ENV,
    }),
    traceExporter: new OTLPTraceExporter({
      url: traceUrl,
      headers: {
        Authorization: headers,
      },
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
  console.info(`OpenTelemetry tracing initialized for service: ${serviceName}`);

  process.on("SIGTERM", () => {
    sdk
      .shutdown()
      .then(() => console.log("Tracing terminated"))
      .catch((error) => console.log("Error terminating tracing", error))
      .finally(() => process.exit(0));
  });
}
