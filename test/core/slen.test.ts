import { describe, expect, it } from 'vitest';
import { generateIdempotencyKey, idempotencyKeyForJob } from '../../src/idempotency.js';
import { AuthenticationError, InvalidRequestError, ServiceUnavailableError, TimeoutError } from '../../src/errors.js';
import { MemorySpanRecorder, type SpanRecorder } from '../../src/observability/recorder.js';
import { Slen } from '../../src/slen.js';
import { FakeFetch } from '../../src/testing/index.js';
import { execution } from '../modules/harness.js';
import { outcome, recordingLogger } from './harness.js';

const HEALTH = {
  app: 'slen',
  release: 'v1.0.12',
  server: 'frankenphp',
  mysql: 'ok',
  redis: 'ok',
  queue: null,
  broadcast: null,
  opcache_preloaded_files: null,
  opcache_cached_scripts: null,
};

describe('slen.health()', () => {
  it('reads /api/health of the hosted API, without an envelope', async () => {
    const http = new FakeFetch().push({ body: HEALTH });
    const slen = new Slen({ apiKey: 'sl_live_key', fetch: http.fetch });

    expect(await slen.health()).toEqual(HEALTH);
    expect(http.last()?.url).toBe('https://api.slen.ai/api/health');
    expect(http.last()?.method).toBe('GET');
  });

  // Keys are sl_live_…; one issued earlier as sg_live_… keeps working. The SDK checks no prefix: the server does.
  it.each(['sl_live_7f3a', 'sg_live_7f3a'])('sends the key as it is, whatever its prefix: %s', async (key) => {
    const http = new FakeFetch().push({ body: HEALTH });

    await new Slen({ apiKey: key, fetch: http.fetch }).health();

    expect(http.last()?.headers['authorization']).toBe(`Bearer ${key}`);
  });

  it('reads it from the address of the options, for a local stack', async () => {
    const http = new FakeFetch().push({ body: HEALTH });

    await new Slen({ apiKey: 'sl_live_key', baseUrl: 'https://api.test/', fetch: http.fetch }).health();

    expect(http.last()?.url).toBe('https://api.test/api/health');
  });

  it('raises the typed error of a refusal', async () => {
    const http = new FakeFetch().push({ status: 401, body: { error: { code: 'invalid_api_key' } } });

    expect(await outcome(new Slen({ apiKey: 'sl_live_key', fetch: http.fetch }).health())).toBeInstanceOf(AuthenticationError);
  });

  it('repeats a 503 and gives up after the retries', async () => {
    const http = new FakeFetch().push({ status: 503, headers: { 'Retry-After': '0' }, body: { error: { code: 'service_unavailable' } } });

    expect(await outcome(new Slen({ apiKey: 'sl_live_key', fetch: http.fetch, retries: 1 }).health())).toBeInstanceOf(ServiceUnavailableError);
    expect(http.requests).toHaveLength(2);
  });

  it.each([
    [0, 1],
    [3, 4],
  ])('takes the retries of the call over the client\'s: retries %i makes %i attempts on a 503', async (retries, attempts) => {
    const http = new FakeFetch().push({ status: 503, headers: { 'Retry-After': '0' }, body: { error: { code: 'service_unavailable' } } });

    expect(await outcome(new Slen({ apiKey: 'sl_live_key', fetch: http.fetch, retries: 2 }).health({ retries }))).toBeInstanceOf(ServiceUnavailableError);
    expect(http.requests).toHaveLength(attempts);
  });

  it('takes the timeout of the call into the clock of each attempt', async () => {
    const http = new FakeFetch().push({ delayMs: 1_000, body: HEALTH });
    const slen = new Slen({ apiKey: 'sl_live_key', fetch: http.fetch, timeoutMs: 60_000, retries: 0 });

    const error = await outcome(slen.health({ timeoutMs: 20 }));

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe('Slen did not answer GET /health within 20 ms.');
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses retries %s before the wire: nothing sent, nothing written', async (retries) => {
    const http = new FakeFetch().push({ body: HEALTH });
    const { logger, records } = recordingLogger();

    const error = await outcome(new Slen({ apiKey: 'sl_live_key', fetch: http.fetch, logger }).health({ retries }));

    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error).toMatchObject({ code: 'invalid_request', status: null });
    expect(http.requests).toEqual([]);
    expect(records).toEqual([]);
  });
});

/** Every call that goes on the wire, with the options it is given; `executions.wait` reads with its own. */
const NETWORK_CALLS: Record<string, (slen: Slen, options: { retries: number }) => Promise<unknown>> = {
  health: (slen, options) => slen.health(options),
  'operations.execute': (slen, options) => slen.operations.execute('support.reply', { messages: [] }, options),
  'operations.executeAsync': (slen, options) => slen.operations.executeAsync('support.reply', { messages: [] }, options),
  'executions.get': (slen, options) => slen.executions.get('74438200973594700', options),
  'executions.trace': (slen, options) => slen.executions.trace('74438200973594700', options),
  'customers.list': (slen, options) => slen.customers.list(options),
  'customers.get': (slen, options) => slen.customers.get('user_8421', options),
  'customers.create': (slen, options) => slen.customers.create('user_8421', options),
  'customers.updateAccount': (slen, options) => slen.customers.updateAccount('user_8421', 'default', options),
  'customers.block': (slen, options) => slen.customers.block('user_8421', options),
  'customers.unblock': (slen, options) => slen.customers.unblock('user_8421', options),
  'customers.delete': (slen, options) => slen.customers.delete('user_8421', options),
  'customers.topUp': (slen, options) => slen.customers.topUp('user_8421', '1', options),
  'customers.charge': (slen, options) => slen.customers.charge('user_8421', '1', options),
  'customers.adjust': (slen, options) => slen.customers.adjust('user_8421', '1', options),
  'customers.entries': (slen, options) => slen.customers.entries('user_8421', options),
  'customers.prices': (slen, options) => slen.customers.prices(options),
};

describe('the retries of a call', () => {
  it.each(Object.entries(NETWORK_CALLS))('are taken by %s', async (_, call) => {
    const http = new FakeFetch().push({ status: 503, headers: { 'Retry-After': '0' }, body: { error: { code: 'service_unavailable' } } });
    const slen = new Slen({ apiKey: 'sl_live_key', fetch: http.fetch, retries: 0 });

    expect(await outcome(call(slen, { retries: 1 }))).toBeInstanceOf(ServiceUnavailableError);
    expect(http.requests).toHaveLength(2);
    expect(await outcome(call(slen, { retries: -1 }))).toBeInstanceOf(InvalidRequestError);
    expect(http.requests).toHaveLength(2);
  });
});

describe('slen.withLogger()', () => {
  it('answers another client with every setting of this one but the logger', async () => {
    const first = recordingLogger();
    const second = recordingLogger();
    const http = new FakeFetch().push({ delayMs: 1_000, body: HEALTH });
    const slen = new Slen({
      apiKey: 'sl_live_key',
      baseUrl: 'https://sdk.example',
      fetch: http.fetch,
      timeoutMs: 20,
      retries: 1,
      headers: { 'X-Tenant': 'tenant-7' },
      logger: first.logger,
      webhookSecret: 'whsec_endpoint',
      webhookToleranceSeconds: 10,
    });
    const copy = slen.withLogger(second.logger);

    const error = await outcome(copy.health());

    expect(copy).not.toBe(slen);
    expect(Object.keys(copy)).toEqual(Object.keys(slen));
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe('Slen did not answer GET /health within 20 ms.');
    expect(http.requests).toHaveLength(2);
    expect(http.last()?.url).toBe('https://sdk.example/api/health');
    expect(http.last()?.headers).toMatchObject({ authorization: 'Bearer sl_live_key', 'x-tenant': 'tenant-7' });
    expect(await copy.webhooks.verify('{}', null)).toBe(false);
    expect(second.records.map((record) => record.event)).toEqual([
      'slen.request',
      'slen.retry',
      'slen.request',
      'slen.failed',
      'slen.webhook.rejected',
    ]);
    expect(first.records).toEqual([]);
  });

  it('keeps each record of 100 calls at once in the logger of the client that made it, over the one fetch', async () => {
    let fetched = 0;
    const echo = (async (input: string | URL | Request) => {
      fetched += 1;
      const id = String(input).split('/').at(-1) ?? '';

      return new Response(JSON.stringify({ data: { external_user_id: id } }), { status: 200, headers: { 'X-Request-Id': id } });
    }) as typeof fetch;
    const shared = recordingLogger();
    const slen = new Slen({ apiKey: 'sl_live_key', fetch: echo, logger: shared.logger });
    const loggers = [recordingLogger(), recordingLogger()];
    const clients = loggers.map(({ logger }) => slen.withLogger(logger));

    await Promise.all(Array.from({ length: 100 }, (_, index) => (clients[index % 2] as Slen).customers.get(`user_${index}`)));

    expect(fetched).toBe(100);
    expect(shared.records).toEqual([]);

    loggers.forEach(({ records }, which) => {
      const answered = records.filter((record) => record.event === 'slen.response').map((record) => String(record.context['request_id']));
      const own = Array.from({ length: 50 }, (_, index) => `user_${index * 2 + which}`);

      expect(records).toHaveLength(100);
      expect(answered.sort()).toEqual(own.sort());
    });
  });

  it('writes the spans of both clients into the one buffer, sent by one flush', async () => {
    const http = new FakeFetch().push({ body: { data: execution() } });
    const collector = new FakeFetch().push({ body: {} });
    const slen = new Slen({
      apiKey: 'sl_live_key',
      fetch: http.fetch,
      otlp: { endpoint: 'http://collector.example', fetch: collector.fetch, flushIntervalMs: 0 },
    });
    const copy = slen.withLogger(recordingLogger().logger);

    await slen.operations.execute('support.reply', { messages: [] }, { idempotencyKey: 'ticket-1:reply' });
    await copy.operations.execute('support.reply', { messages: [] }, { idempotencyKey: 'ticket-2:reply' });
    await copy.flush();
    await slen.flush();

    const batches = collector.requests.map(
      (request) => (request.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> }).resourceSpans[0]?.scopeSpans[0]?.spans ?? [],
    );

    expect(http.requests).toHaveLength(2);
    expect(batches.map((spans) => spans.length)).toEqual([2]);
  });
});

describe('slen.flush()', () => {
  it('flushes the recorder of the options', async () => {
    let flushed = 0;
    const recorder: SpanRecorder = {
      record: () => undefined,
      flush: async () => {
        flushed += 1;
      },
    };

    await new Slen({ apiKey: 'sl_live_key', spanRecorder: recorder }).flush();

    expect(flushed).toBe(1);
  });

  it('flushes the OTLP exporter of the options next to the recorder', async () => {
    const collector = new FakeFetch().push({ body: {} });
    const recorder = new MemorySpanRecorder();
    const slen = new Slen({
      apiKey: 'sl_live_key',
      spanRecorder: recorder,
      otlp: { endpoint: 'http://collector.example', fetch: collector.fetch, flushIntervalMs: 0 },
    });

    await expect(slen.flush()).resolves.toBeUndefined();
    expect(collector.requests).toEqual([]);
  });

  it('never rejects', async () => {
    const recorder: SpanRecorder = {
      record: () => undefined,
      flush: () => Promise.reject(new Error('collector down')),
    };

    await expect(new Slen({ apiKey: 'sl_live_key', spanRecorder: recorder }).flush()).resolves.toBeUndefined();
  });
});

describe('idempotency keys', () => {
  it('are v4 UUIDs when generated', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateIdempotencyKey()));

    expect(keys.size).toBe(50);

    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('of a job are one key for the job, the same on every retry of it', () => {
    expect(idempotencyKeyForJob('3f0c1d7e', 'support.reply')).toBe('job:3f0c1d7e:support.reply');
    expect(idempotencyKeyForJob('3f0c1d7e', 'support.reply')).toBe(idempotencyKeyForJob('3f0c1d7e', 'support.reply'));
    expect(() => idempotencyKeyForJob(' ', 'support.reply')).toThrow(TypeError);
    expect(() => idempotencyKeyForJob('3f0c1d7e', '')).toThrow(TypeError);
  });
});
