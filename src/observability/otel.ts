import type { SpanRecorder } from './recorder.js';
import { spanAttributes, type SlenSpan } from './span.js';

/** The part of an `@opentelemetry/api` span the bridge uses. */
export interface OtelSpanLike {
  setAttributes(attributes: Record<string, string | number | boolean>): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  end(endTime?: number): void;
}

/** The part of an `@opentelemetry/api` tracer the bridge uses; the package itself is never imported. */
export interface OtelTracerLike {
  startSpan(name: string, options?: { startTime?: number; kind?: number }): OtelSpanLike;
}

// `SpanStatusCode.ERROR` and `SpanKind.CLIENT`, written out so the enums are not an import.
const STATUS_ERROR = 2;
const KIND_CLIENT = 2;

/** Writes spans through a tracer the application already has, so they join its traces. */
export class OtelSpanRecorder implements SpanRecorder {
  readonly #tracer: OtelTracerLike;

  constructor(tracer: OtelTracerLike) {
    this.#tracer = tracer;
  }

  record(span: SlenSpan): void {
    const end = Date.now();
    const otelSpan = this.#tracer.startSpan(`slen.${span.operation}`, { startTime: end - span.durationMs, kind: KIND_CLIENT });

    otelSpan.setAttributes(spanAttributes(span));

    if (span.outcome !== 'ok') {
      otelSpan.setStatus({ code: STATUS_ERROR, message: span.errorCode ?? span.outcome });
    }

    otelSpan.end(end);
  }
}

/** A recorder on the tracer of `@opentelemetry/api`, or null when the package is not installed. */
export async function otelSpanRecorder(tracerName = '@slen/sdk'): Promise<OtelSpanRecorder | null> {
  // A variable, not a literal: a bundler would try to resolve an optional dependency at build time.
  const specifier = '@opentelemetry/api';

  try {
    const api = (await import(specifier)) as { trace?: { getTracer(name: string): OtelTracerLike } };
    const tracer = api.trace?.getTracer(tracerName);

    return tracer === undefined ? null : new OtelSpanRecorder(tracer);
  } catch {
    return null;
  }
}
