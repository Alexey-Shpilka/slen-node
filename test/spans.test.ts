import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  BudgetExceededError,
  ConcurrencyLimitError,
  ConnectionError,
  InsufficientCreditsError,
  InvalidRequestError,
  PolicyDeniedError,
  ProviderError,
  RateLimitError,
  SlenError,
  SpendRefusedError,
} from '../src/errors.js';
import { OtelSpanRecorder } from '../src/observability/otel.js';
import { OtlpSpanRecorder } from '../src/observability/otlp.js';
import { LoggerSpanRecorder, MemorySpanRecorder, MultiSpanRecorder, type SpanRecorder } from '../src/observability/recorder.js';
import { SpanScope, type SpannedRun } from '../src/observability/scope.js';
import type { SlenSpan } from '../src/observability/span.js';
import { Slen } from '../src/slen.js';
import { FakeFetch } from '../src/testing/index.js';

function run(fields: Partial<SpannedRun> = {}): SpannedRun {
  return {
    execution_id: '74438200973594700',
    status: 'completed',
    operation: 'support.reply',
    error_code: null,
    cost: { estimated: '0.00412500', actual: '0.00398000' },
    cache: { hit: false },
    ...fields,
  };
}

/** A scope on a clock the test moves, and the spans it wrote. */
function scope(
  operation: 'operations.execute' | 'operations.execute_async' | 'executions.wait' = 'operations.execute',
  known: { operationCode?: string | null; executionId?: string | null } = { operationCode: 'support.reply' },
): { scope: SpanScope; spans: SlenSpan[]; tick(ms: number): void } {
  const recorder = new MemorySpanRecorder();
  let now = 1_000;

  return {
    scope: new SpanScope(recorder, { operation, ...known }, () => now),
    spans: recorder.spans,
    tick: (ms: number): void => {
      now += ms;
    },
  };
}

describe('the span of a run', () => {
  it('carries the run, its costs and the time the call took', () => {
    const { scope: open, spans, tick } = scope();

    tick(42);
    open.execution(run());

    expect(spans).toEqual([
      {
        operation: 'operations.execute',
        outcome: 'ok',
        status: 'completed',
        durationMs: 42,
        executionId: '74438200973594700',
        operationCode: 'support.reply',
        estimated: '0.00412500',
        actual: '0.00398000',
        errorCode: null,
        cacheHit: false,
      },
    ]);
  });

  it.each([
    ['completed', 'ok'],
    ['queued', 'ok'],
    ['waiting', 'ok'],
    ['running', 'ok'],
    ['rejected', 'refused'],
    ['failed', 'error'],
    ['uncertain', 'error'],
  ])('reads the outcome of a %s run off its status: %s', (status, outcome) => {
    const { scope: open, spans } = scope();

    open.execution(run({ status, error_code: status === 'completed' ? null : 'some_code' }));

    expect(spans[0]?.outcome).toBe(outcome);
    expect(spans[0]?.status).toBe(status);
  });

  it('says nothing about the cache of a run that has no answer yet, and says a hit or a miss of one that has', () => {
    for (const status of ['queued', 'waiting', 'running']) {
      const { scope: open, spans } = scope();
      open.execution(run({ status, cache: { hit: false } }));
      expect(spans[0]?.cacheHit, status).toBeNull();
    }

    const hit = scope();
    hit.scope.execution(run({ cache: { hit: true } }));
    expect(hit.spans[0]?.cacheHit).toBe(true);

    const refused = scope();
    refused.scope.execution(run({ status: 'rejected', error_code: 'rejected_by_flow' }));
    expect(refused.spans[0]?.cacheHit).toBe(false);
  });

  it('takes the code of the row, and the one of `error` when the row has none', () => {
    const fromRow = scope();
    fromRow.scope.execution(run({ status: 'rejected', error_code: 'insufficient_credits', error: { code: 'other' } }));
    expect(fromRow.spans[0]?.errorCode).toBe('insufficient_credits');

    const fromError = scope();
    fromError.scope.execution(run({ status: 'rejected', error_code: null, error: { code: 'rejected_by_flow' } }));
    expect(fromError.spans[0]?.errorCode).toBe('rejected_by_flow');
  });

  it('names the operation and the run the answer names, over what was known before', () => {
    const { scope: open, spans } = scope('executions.wait', { executionId: '1', operationCode: null });

    open.execution(run({ execution_id: '2', operation: 'report.summarize' }));

    expect(spans[0]).toMatchObject({ operation: 'executions.wait', executionId: '2', operationCode: 'report.summarize' });
  });
});

describe('the span of a call that threw', () => {
  it.each([
    ['a refusal of money', new BudgetExceededError('no', { code: 'budget_exceeded', status: 402 }), 'refused'],
    ['an empty account', new InsufficientCreditsError('no', { code: 'insufficient_credits', status: 402 }), 'refused'],
    ['a budget limit', new ConcurrencyLimitError('no', { code: 'concurrency_limit_exceeded', status: 402 }), 'refused'],
    ['a 402 nobody named', new SpendRefusedError('no', { code: 'a_402_of_the_future', status: 402 }), 'refused'],
    ['a policy', new PolicyDeniedError('no', { code: 'policy_denied', status: 403 }), 'refused'],
    ['a key that was refused', new AuthenticationError('no', { code: 'insufficient_scope', status: 403 }), 'error'],
    ['the rate limit of the key', new RateLimitError('no', { code: 'rate_limit_exceeded', status: 429 }), 'error'],
    ['a provider', new ProviderError('no', { code: 'provider_error', status: 502 }), 'error'],
    ['a request to fix', new InvalidRequestError('no', { code: 'invalid_request' }), 'error'],
    ['no answer', new ConnectionError('no'), 'error'],
    ['something that is not ours', new TypeError('no'), 'error'],
  ])('writes %s as %s, with its code and no status', (_what, error, outcome) => {
    const { scope: open, spans } = scope('operations.execute', { operationCode: 'support.reply' });

    open.failed(error);

    expect(spans[0]).toMatchObject({
      operation: 'operations.execute',
      outcome,
      status: null,
      executionId: null,
      operationCode: 'support.reply',
      errorCode: error instanceof SlenError ? error.code : null,
      estimated: null,
      actual: null,
      cacheHit: null,
    });
  });

  it('still names the run a wait was about, and the operation it had read', () => {
    const { scope: open, spans } = scope('executions.wait', { executionId: '74438200973594700' });

    open.failed(new ConnectionError('no'), 'report.summarize');

    expect(spans[0]).toMatchObject({ executionId: '74438200973594700', operationCode: 'report.summarize', outcome: 'error' });
  });

  it('never lets a recorder that throws break the call', () => {
    const broken: SpanRecorder = {
      record(): void {
        throw new Error('the exporter is down');
      },
    };
    const open = new SpanScope(broken, { operation: 'operations.execute' });

    expect(() => open.execution(run())).not.toThrow();
    expect(() => open.failed(new Error('boom'))).not.toThrow();
  });
});

describe('recorders', () => {
  const span: SlenSpan = {
    operation: 'operations.execute',
    outcome: 'ok',
    status: 'completed',
    durationMs: 5,
    executionId: '744',
    operationCode: 'support.reply',
    estimated: '0.01',
    actual: null,
    errorCode: null,
    cacheHit: false,
  };

  it('logs a flat snake_case attribute set', () => {
    const info = vi.fn();
    new LoggerSpanRecorder({ info }).record(span);

    expect(info).toHaveBeenCalledWith('slen.span', {
      operation: 'operations.execute',
      outcome: 'ok',
      status: 'completed',
      duration_ms: 5,
      execution_id: '744',
      operation_code: 'support.reply',
      estimated: '0.01',
      cache_hit: false,
    });
  });

  it('keeps going when one recorder in a fan-out throws', () => {
    const memory = new MemorySpanRecorder();
    new MultiSpanRecorder([
      {
        record(): void {
          throw new Error('nope');
        },
      },
      memory,
    ]).record(span);

    expect(memory.spans).toEqual([span]);
    expect(memory.last()).toBe(span);
  });

  it('posts OTLP/HTTP JSON with the span attributes', async () => {
    const posted: Array<{ url: string; body: unknown }> = [];
    const recorder = new OtlpSpanRecorder({
      endpoint: 'http://collector:4318/',
      serviceName: 'checkout',
      resourceAttributes: { 'deployment.environment': 'test' },
      flushIntervalMs: 0,
      fetch: (async (url: string, init: RequestInit) => {
        posted.push({ url, body: JSON.parse(init.body as string) as unknown });

        return new Response('{}');
      }) as unknown as typeof fetch,
    });

    recorder.record(span);
    recorder.record({ ...span, outcome: 'refused', status: null, errorCode: 'budget_exceeded' });
    await recorder.flush();

    expect(posted[0]?.url).toBe('http://collector:4318/v1/traces');

    const document = posted[0]?.body as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: unknown }> };
        scopeSpans: Array<{
          scope: { name: string };
          spans: Array<{
            name: string;
            traceId: string;
            spanId: string;
            kind: number;
            attributes: Array<{ key: string; value: unknown }>;
            status: { code: number; message?: string };
          }>;
        }>;
      }>;
    };
    const [ok, refused] = document.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];

    expect(document.resourceSpans[0]?.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'checkout' } },
      { key: 'deployment.environment', value: { stringValue: 'test' } },
    ]);
    expect(document.resourceSpans[0]?.scopeSpans[0]?.scope.name).toBe('@slen/sdk');
    expect(ok?.name).toBe('slen.operations.execute');
    expect(ok?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ok?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ok?.kind).toBe(3);
    expect(ok?.attributes).toEqual([
      { key: 'operation', value: { stringValue: 'operations.execute' } },
      { key: 'outcome', value: { stringValue: 'ok' } },
      { key: 'status', value: { stringValue: 'completed' } },
      { key: 'duration_ms', value: { intValue: '5' } },
      { key: 'execution_id', value: { stringValue: '744' } },
      { key: 'operation_code', value: { stringValue: 'support.reply' } },
      { key: 'estimated', value: { stringValue: '0.01' } },
      // `cache_hit` has a boolean of its own: the string "false" would read as a truthy one.
      { key: 'cache_hit', value: { boolValue: false } },
    ]);
    expect(ok?.status).toEqual({ code: 0 });
    expect(refused?.status).toEqual({ code: 2, message: 'budget_exceeded' });
  });

  /** A collector whose answers the test hands out one by one, in the order the batches were posted. */
  function slowCollector(): { fetch: typeof fetch; posted: number[]; answer(index: number, status?: number): void } {
    const posted: number[] = [];
    const waiting: Array<(response: Response) => void> = [];

    return {
      posted,
      fetch: ((_url: string, init: RequestInit) => {
        const document = JSON.parse(init.body as string) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> };

        posted.push(document.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0);

        return new Promise<Response>((resolve) => {
          waiting.push(resolve);
        });
      }) as unknown as typeof fetch,
      answer(index: number, status = 200): void {
        waiting[index]?.(new Response('{}', { status }));
      },
    };
  }

  /** Lets everything already queued run, without touching a timer the code under test owns. */
  async function turn(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  it('does not resolve a flush while an earlier batch is still on its way', async () => {
    const collector = slowCollector();
    const recorder = new OtlpSpanRecorder({ endpoint: 'http://collector:4318', flushIntervalMs: 0, fetch: collector.fetch });

    recorder.record(span);
    const first = recorder.flush();
    recorder.record(span);
    recorder.record(span);
    void recorder.flush();

    let done = false;
    const last = recorder.flush().then(() => {
      done = true;
    });

    await turn();
    expect(collector.posted).toEqual([1]);
    expect(done).toBe(false);

    collector.answer(0);
    await first;
    await turn();
    expect(collector.posted).toEqual([1, 2]);
    expect(done).toBe(false);

    collector.answer(1);
    await last;
    expect(done).toBe(true);
  });

  it('waits for the batch the queue limit sent on its own', async () => {
    const collector = slowCollector();
    const recorder = new OtlpSpanRecorder({ endpoint: 'http://collector:4318', flushIntervalMs: 0, maxQueueSize: 2, fetch: collector.fetch });

    recorder.record(span);
    recorder.record(span);

    let done = false;
    const flushed = recorder.flush().then(() => {
      done = true;
    });

    await turn();
    expect(collector.posted).toEqual([2]);
    expect(done).toBe(false);

    collector.answer(0);
    await flushed;
    expect(done).toBe(true);
  });

  it('tells onError when the collector answers anything but a 2xx, and still resolves', async () => {
    const onError = vi.fn();
    const recorder = new OtlpSpanRecorder({
      endpoint: 'http://collector:4318',
      flushIntervalMs: 0,
      onError,
      fetch: (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch,
    });

    recorder.record(span);
    recorder.record(span);

    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);

    const [error, dropped] = onError.mock.calls[0] as [Error, number];

    expect(error.message).toContain('401');
    expect(error.message).toContain('http://collector:4318/v1/traces');
    expect(dropped).toBe(2);
  });

  it('tells onError when the collector cannot be reached, and nothing about a batch that was delivered', async () => {
    const unreachable = vi.fn();
    const down = new OtlpSpanRecorder({
      endpoint: 'http://collector:4318',
      flushIntervalMs: 0,
      onError: unreachable,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });

    down.record(span);
    await down.flush();
    expect(unreachable).toHaveBeenCalledWith(expect.objectContaining({ message: 'fetch failed' }), 1);

    const delivered = vi.fn();
    const up = new OtlpSpanRecorder({
      endpoint: 'http://collector:4318',
      flushIntervalMs: 0,
      onError: delivered,
      fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    });

    up.record(span);
    await up.flush();
    expect(delivered).not.toHaveBeenCalled();
  });

  it('does not let a throwing onError, or the rejection of an async one, break the flush or the next batch', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    // No `@types/node`: the two members of `process` used here, described structurally.
    const { process } = globalThis as unknown as {
      process: Record<'on' | 'off', (event: 'unhandledRejection', listener: (reason: unknown) => void) => void>;
    };
    const posted: number[] = [];
    const statuses = [500, 500, 200];

    process.on('unhandledRejection', onUnhandled);

    try {
      for (const onError of [
        (): void => {
          throw new Error('the alerting is down too');
        },
        async (): Promise<void> => {
          throw new Error('the alerting is down too');
        },
      ]) {
        const recorder = new OtlpSpanRecorder({
          endpoint: 'http://collector:4318',
          flushIntervalMs: 0,
          onError,
          fetch: (async () => {
            const status = statuses.shift() ?? 200;
            posted.push(status);

            return new Response('{}', { status });
          }) as unknown as typeof fetch,
        });

        recorder.record(span);
        await expect(recorder.flush()).resolves.toBeUndefined();
      }

      await turn();
      await turn();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(posted).toEqual([500, 500]);
    expect(unhandled).toEqual([]);
  });

  it('gives up a POST the collector never answers, reports the batch and sends the next one', async () => {
    const onError = vi.fn();
    const signals: AbortSignal[] = [];
    const recorder = new OtlpSpanRecorder({
      endpoint: 'http://collector:4318',
      flushIntervalMs: 0,
      timeoutMs: 20,
      onError,
      // The first POST is never answered, and this fetch does not even honour its signal.
      fetch: ((_url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal);

        return signals.length === 1 ? new Promise<Response>(() => undefined) : Promise.resolve(new Response('{}'));
      }) as unknown as typeof fetch,
    });

    recorder.record(span);
    recorder.record(span);
    const first = recorder.flush();
    recorder.record(span);

    await expect(recorder.flush()).resolves.toBeUndefined();
    await expect(first).resolves.toBeUndefined();

    expect(signals).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(1);

    const [error, dropped] = onError.mock.calls[0] as [Error, number];

    expect(error.message).toContain('did not answer within 20 ms');
    expect(dropped).toBe(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('gives a POST ten seconds by default, and takes a timeout that is not a number as that default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      for (const timeoutMs of [undefined, Number(undefined), 0, Number.POSITIVE_INFINITY]) {
        const onError = vi.fn();
        const recorder = new OtlpSpanRecorder({
          endpoint: 'http://collector:4318',
          flushIntervalMs: 0,
          onError,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
        });

        recorder.record(span);
        const flushed = recorder.flush();

        await vi.advanceTimersByTimeAsync(9_999);
        expect(onError).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await flushed;
        expect(onError).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps no more than maxPendingBatches waiting behind a slow POST, and reports the one too many', async () => {
    const collector = slowCollector();
    const onError = vi.fn();
    const recorder = new OtlpSpanRecorder({
      endpoint: 'http://collector:4318',
      flushIntervalMs: 0,
      maxQueueSize: 1,
      maxPendingBatches: 2,
      onError,
      fetch: collector.fetch,
    });

    for (let recorded = 0; recorded < 6; recorded += 1) {
      recorder.record(span);
    }

    await turn();
    expect(collector.posted).toEqual([1]);
    expect(onError).toHaveBeenCalledTimes(3);
    expect((onError.mock.calls[0] as [Error, number])[0].message).toContain('2 batches are already waiting');

    collector.answer(0);
    await turn();
    collector.answer(1);
    await turn();
    collector.answer(2);
    await recorder.flush();
    expect(collector.posted).toEqual([1, 1, 1]);

    recorder.record(span);
    await turn();
    collector.answer(3);
    await recorder.flush();
    expect(collector.posted).toEqual([1, 1, 1, 1]);
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it('reports a span it cannot build for want of Web Crypto, and throws nothing at the call', async () => {
    const onError = vi.fn();
    const recorder = new OtlpSpanRecorder({ endpoint: 'http://collector:4318', flushIntervalMs: 0, onError, fetch: vi.fn() as unknown as typeof fetch });
    vi.stubGlobal('crypto', undefined);

    try {
      expect(() => recorder.record(span)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }

    await recorder.flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Web Crypto') as string }), 1);
  });

  it('flushes what is left and stops its timer on shutdown', async () => {
    const posted: string[] = [];
    const recorder = new OtlpSpanRecorder({
      endpoint: 'http://collector:4318/v1/traces',
      flushIntervalMs: 60_000,
      fetch: (async (url: string) => {
        posted.push(url);

        return new Response('{}');
      }) as unknown as typeof fetch,
    });

    recorder.record(span);
    await recorder.shutdown();

    expect(posted).toEqual(['http://collector:4318/v1/traces']);
  });

  it('bridges to an OpenTelemetry tracer without importing one', () => {
    const started: Array<{ name: string; options: unknown }> = [];
    const otelSpan = { setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    const recorder = new OtelSpanRecorder({
      startSpan: (name, options) => {
        started.push({ name, options });

        return otelSpan;
      },
    });

    recorder.record({ ...span, outcome: 'refused', status: null, errorCode: 'budget_exceeded' });

    expect(started[0]?.name).toBe('slen.operations.execute');
    expect(started[0]?.options).toMatchObject({ kind: 2 });
    expect(otelSpan.setAttributes).toHaveBeenCalledWith(expect.objectContaining({ operation_code: 'support.reply' }));
    expect(otelSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: 'budget_exceeded' });
    expect(otelSpan.end).toHaveBeenCalled();

    const quiet = { setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    new OtelSpanRecorder({ startSpan: () => quiet }).record(span);
    expect(quiet.setStatus).not.toHaveBeenCalled();
  });
});

describe('slen.flush()', () => {
  it('flushes every recorder that buffers, the one of `otlp` too, and survives one whose flush fails', async () => {
    const posted: string[] = [];
    const collect = (async (url: string) => {
      posted.push(url);

      return new Response('{}');
    }) as unknown as typeof fetch;
    const own = new OtlpSpanRecorder({ endpoint: 'http://own:4318', flushIntervalMs: 0, fetch: collect });
    const broken: SpanRecorder = {
      record(): void {},
      async flush(): Promise<void> {
        throw new Error('the exporter is down');
      },
    };
    const slen = new Slen({
      apiKey: 'sl_live_key',
      fetch: new FakeFetch().fetch,
      spanRecorder: new MultiSpanRecorder([broken, own]),
      otlp: { endpoint: 'http://option:4318', flushIntervalMs: 0, fetch: collect },
    });

    own.record(span());
    await expect(slen.flush()).resolves.toBeUndefined();

    expect(posted).toEqual(['http://own:4318/v1/traces']);
  });
});

function span(): SlenSpan {
  return {
    operation: 'operations.execute',
    outcome: 'ok',
    status: 'completed',
    durationMs: 1,
    executionId: '1',
    operationCode: 'support.reply',
    estimated: null,
    actual: null,
    errorCode: null,
    cacheHit: false,
  };
}
