import { NodeSdk } from '@effect/opentelemetry';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Layer, Option } from 'effect';

const SERVICE_NAME = 'rippls';

export const makeTracingLayer = (url: Option.Option<string>) => {
  if (Option.isNone(url)) {
    return Layer.empty;
  }

  return NodeSdk.layer(() => ({
    resource: { serviceName: SERVICE_NAME },
    spanProcessor: new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: url.value,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
      { scheduledDelayMillis: 500 }
    ),
  }));
};
