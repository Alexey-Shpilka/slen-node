import { webCrypto } from '../idempotency.js';
import type { SpanRecorder } from './recorder.js';
import { spanAttributes, type SlenSpan } from './span.js';

export interface OtlpExporterOptions {
  /** Collector base URL (`/v1/traces` is appended) or the full traces URL. */
  endpoint: string;
  headers?: Record<string, string>;
  /** `service.name` of the resource. Default `slen-sdk`. */
  serviceName?: string;
  /** More resource attributes, e.g. `deployment.environment`. */
  resourceAttributes?: Record<string, string>;
  /** Sends a batch when this many spans are buffered. Default 128. */
  maxQueueSize?: number;
  /** Sends what is buffered at least this often, in ms. Default 5000; `0` switches the timer off. */
  flushIntervalMs?: number;
  /** How long one POST may take, in ms. Default 10 000; a value that is not a number of at least 1 takes it. */
  timeoutMs?: number;
  /** How many batches may wait behind the one being sent. Default 16; one more is dropped and reported. */
  maxPendingBatches?: number;
  fetch?: typeof fetch;
  /** Told of every batch that was dropped: unreachable, no answer in time, not a 2xx, too many waiting. */
  onError?: (error: Error, droppedSpans: number) => void;
}

interface OtlpAttribute {
  key: string;
  value: { stringValue: string } | { intValue: string } | { boolValue: boolean };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}

const DEFAULT_MAX_QUEUE_SIZE = 128;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_BATCHES = 16;

// `setTimeout` keeps its delay in a signed 32-bit integer and fires at once beyond it.
const LONGEST_TIMER_MS = 2_147_483_647;

const SPAN_KIND_CLIENT = 3;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

/** Sends spans to an OTLP/HTTP collector as JSON, a batch at a time; a batch that fails is dropped and told to `onError`. */
export class OtlpSpanRecorder implements SpanRecorder {
  readonly #options: OtlpExporterOptions;
  readonly #url: string;
  readonly #maxQueueSize: number;
  readonly #timeoutMs: number;
  readonly #maxPendingBatches: number;
  readonly #send: typeof fetch;
  #buffer: OtlpSpan[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<void> = Promise.resolve();
  #outstanding = 0;

  constructor(options: OtlpExporterOptions) {
    const base = options.endpoint.replace(/\/+$/, '');

    this.#options = options;
    this.#url = base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
    this.#maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.#timeoutMs = atLeastOne(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.#maxPendingBatches = Math.floor(atLeastOne(options.maxPendingBatches, DEFAULT_MAX_PENDING_BATCHES));
    this.#send = options.fetch ?? globalThis.fetch;

    const interval = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    if (interval > 0) {
      this.#timer = setInterval(() => void this.flush(), interval);
      // Telemetry never holds a CLI or a serverless invocation open; a browser's handle has no `unref`.
      (this.#timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  record(span: SlenSpan): void {
    let otlp: OtlpSpan;

    try {
      otlp = toOtlp(span);
    } catch (error) {
      // No Web Crypto for the ids: a dropped span like any other, told and not thrown.
      this.#failed(asError(error), 1);

      return;
    }

    this.#buffer.push(otlp);

    if (this.#buffer.length >= this.#maxQueueSize) {
      void this.flush();
    }
  }

  /** Resolves when everything recorded so far was sent or given up. Never rejects. */
  async flush(): Promise<void> {
    const batch = this.#buffer;

    if (batch.length > 0) {
      this.#buffer = [];
      this.#enqueue(batch);
    }

    return this.#inFlight;
  }

  /** Stops the timer and flushes what is left. */
  async shutdown(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    await this.flush();
  }

  // Chained, not replaced: a flush waits for the batches already on their way too.
  #enqueue(batch: OtlpSpan[]): void {
    if (this.#outstanding > this.#maxPendingBatches) {
      this.#failed(
        new Error(`Slen: ${this.#maxPendingBatches} batches are already waiting for the OTLP collector at ${this.#url}; this one was dropped.`),
        batch.length,
      );

      return;
    }

    this.#outstanding += 1;
    this.#inFlight = this.#inFlight.then(async () => {
      try {
        await this.#post(batch);
      } finally {
        this.#outstanding -= 1;
      }
    });
  }

  async #post(spans: OtlpSpan[]): Promise<void> {
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: toAttributes({ 'service.name': this.#options.serviceName ?? 'slen-sdk', ...this.#options.resourceAttributes }),
          },
          scopeSpans: [{ scope: { name: '@slen/sdk' }, spans }],
        },
      ],
    };

    try {
      const response = await this.#answered((signal) =>
        this.#send(this.#url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.#options.headers },
          body: JSON.stringify(body),
          signal,
        }),
      );

      letGo(response);

      if (!response.ok) {
        this.#failed(new Error(`Slen: the OTLP collector at ${this.#url} answered ${response.status}.`), spans.length);
      }
    } catch (error) {
      this.#failed(asError(error), spans.length);
    }
  }

  // The signal ends a `fetch` that honours it; the race ends the wait for one that does not.
  async #answered(send: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sent = send(controller.signal);
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Slen: the OTLP collector at ${this.#url} did not answer within ${this.#timeoutMs} ms.`);

        reject(error);
        controller.abort(error);
        sent.then(letGo, () => undefined);
      }, Math.min(this.#timeoutMs, LONGEST_TIMER_MS));
    });

    try {
      return await Promise.race([sent, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  // An `async` listener's rejection is caught too: unhandled, it would end a Node process.
  #failed(error: Error, droppedSpans: number): void {
    try {
      const told: unknown = this.#options.onError?.(error, droppedSpans);

      Promise.resolve(told).catch(() => undefined);
    } catch {
      // The listener is telemetry about telemetry.
    }
  }
}

function toOtlp(span: SlenSpan): OtlpSpan {
  const endMs = Date.now();

  return {
    // No context API to join an ambient trace: each span is its own trace.
    traceId: hex(16),
    spanId: hex(8),
    name: `slen.${span.operation}`,
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: `${endMs - span.durationMs}000000`,
    endTimeUnixNano: `${endMs}000000`,
    attributes: toAttributes(spanAttributes(span)),
    status: span.outcome === 'ok' ? { code: STATUS_UNSET } : { code: STATUS_ERROR, message: span.errorCode ?? span.outcome },
  };
}

function toAttributes(values: Record<string, string | number | boolean>): OtlpAttribute[] {
  return Object.entries(values).map(([key, value]) => {
    if (typeof value === 'number') {
      return { key, value: { intValue: String(Math.round(value)) } };
    }

    return typeof value === 'boolean' ? { key, value: { boolValue: value } } : { key, value: { stringValue: value } };
  });
}

function hex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  webCrypto().getRandomValues(buffer);

  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// `NaN` from an unset environment variable takes the default as well.
function atLeastOne(given: number | undefined, fallback: number): number {
  const value = Number(given ?? fallback);

  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

function letGo(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
