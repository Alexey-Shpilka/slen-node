import { describe, expect, it } from 'vitest';
import {
  ConnectionError,
  OperationUncertainError,
  ProviderError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
} from '../../src/errors.js';
import { resolveConfig } from '../../src/config.js';
import { FetchClient } from '../../src/http/client.js';
import { HttpJournal } from '../../src/http/logging.js';
import { backoffMs, RETRY_AFTER_CEILING_MS, retryAfterMs, RetryClient } from '../../src/http/retry.js';
import { NOOP_LOGGER } from '../../src/logger.js';
import { Slen } from '../../src/slen.js';
import { FakeFetch } from '../../src/testing/index.js';
import { chain, outcome } from './harness.js';

const EXECUTE = { method: 'POST', route: '/v1/operations/execute', body: { operation: 'support.reply' }, idempotencyKey: 'ticket-42' } as const;

describe('a request is sent again', () => {
  it('after no answer, with a backoff, under the same idempotency key', async () => {
    let calls = 0;
    const seen: Array<string | null> = [];
    const flaky = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      seen.push(new Headers(args[1]?.headers).get('idempotency-key'));

      if (calls === 1) {
        throw new TypeError('socket hang up');
      }

      return new Response(JSON.stringify({ data: { status: 'completed' } }), { status: 200 });
    }) as typeof fetch;
    const { api, pauses } = chain({ fetch: flaky });

    expect(await api.request(EXECUTE)).toEqual({ status: 'completed' });
    expect(calls).toBe(2);
    expect(pauses).toEqual([200]);
    expect(seen).toEqual(['ticket-42', 'ticket-42']);
  });

  it('after a timeout of the attempt', async () => {
    const { api, http, pauses } = chain({ timeoutMs: 20 });
    http.push({ delayMs: 1_000, body: { data: {} } }).push({ body: { data: { ok: true } } });

    expect(await api.request(EXECUTE)).toEqual({ ok: true });
    expect(pauses).toEqual([200]);
  });

  it('after a 429, waiting what Retry-After asks', async () => {
    const { api, http, pauses } = chain();
    http.push({ status: 429, headers: { 'Retry-After': '3' }, body: { error: { code: 'rate_limit_exceeded' } } }).push({ body: { data: { ok: true } } });

    expect(await api.request(EXECUTE)).toEqual({ ok: true });
    expect(pauses).toEqual([3_000]);
    expect(http.requests.map((request) => request.headers['idempotency-key'])).toEqual(['ticket-42', 'ticket-42']);
  });

  it('after a 503, waiting the backoff when there is no Retry-After', async () => {
    const { api, http, pauses } = chain();
    http
      .push({ status: 503, body: { error: { code: 'ledger_unavailable' } } })
      .push({ status: 503, body: { error: { code: 'service_unavailable' } } })
      .push({ body: { data: { ok: true } } });

    expect(await api.request(EXECUTE)).toEqual({ ok: true });
    expect(pauses).toEqual([200, 400]);
  });

  it('after a 503 whose Retry-After is a date', async () => {
    const { api, http, pauses } = chain();
    http.push({ status: 503, headers: { 'Retry-After': new Date(Date.now() + 10_000).toUTCString() }, body: {} }).push({ body: { data: {} } });

    await api.request(EXECUTE);

    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toBeGreaterThan(8_000);
    expect(pauses[0]).toBeLessThanOrEqual(10_000);
  });

  it('as often as `retries` says and no more, then the last answer decides', async () => {
    const { api, http, pauses } = chain({ retries: 2 });
    http.push({ status: 503, body: { error: { code: 'service_unavailable' } } });

    const error = await outcome(api.request(EXECUTE));

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(http.requests).toHaveLength(3);
    expect(pauses).toEqual([200, 400]);
  });

  it('as often as the request says, when it says', async () => {
    const { api, http } = chain({ retries: 2 });
    http.push({ status: 503, body: {} });

    await outcome(api.request({ ...EXECUTE, retries: 0 }));

    expect(http.requests).toHaveLength(1);
  });

  it('until no answer has come for every attempt, which is then the error', async () => {
    const { api, http } = chain({ timeoutMs: 10, retries: 1 });
    http.push({ delayMs: 1_000, body: { data: {} } });

    expect(await outcome(api.request(EXECUTE))).toBeInstanceOf(TimeoutError);
    expect(http.requests).toHaveLength(2);
  });
});

describe('a request is not sent again', () => {
  it.each([
    [500, 'provider_error', ProviderError],
    [502, null, ProviderError],
    [504, 'operation_uncertain', OperationUncertainError],
  ] as const)('after a %i: a provider may have been paid', async (status, code, type) => {
    const { api, http } = chain();
    http.push({ status, body: code === null ? {} : { error: { code } } });

    expect(await outcome(api.request(EXECUTE))).toBeInstanceOf(type);
    expect(http.requests).toHaveLength(1);
  });

  it.each([400, 402, 404, 409, 422])('after a %i', async (status) => {
    const { api, http } = chain();
    http.push({ status, body: { error: { code: 'some_refusal' } } });

    await outcome(api.request(EXECUTE));

    expect(http.requests).toHaveLength(1);
  });

  it('after a 429 whose Retry-After is past the ceiling: the caller gets the RateLimitError at once', async () => {
    const { api, http, pauses } = chain();
    http.push({ status: 429, headers: { 'Retry-After': String(RETRY_AFTER_CEILING_MS / 1000 + 1) }, body: { error: { code: 'rate_limit_exceeded' } } });

    const error = await outcome(api.request(EXECUTE));

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterSeconds).toBe(RETRY_AFTER_CEILING_MS / 1000 + 1);
    expect(http.requests).toHaveLength(1);
    expect(pauses).toEqual([]);
  });

  it('after a 503 whose Retry-After is past the ceiling', async () => {
    const { api, http } = chain();
    http.push({ status: 503, headers: { 'Retry-After': '120' }, body: { error: { code: 'service_unavailable' } } });

    const error = await outcome(api.request(EXECUTE));

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as ServiceUnavailableError).retryAfterSeconds).toBe(120);
    expect(http.requests).toHaveLength(1);
  });

  it('tells the caller how long an answer asked to wait, as seconds from a number or a date, or null', async () => {
    const { api, http } = chain({ retries: 0 });
    const inAMinute = new Date(Date.now() + 60_000).toUTCString();
    http
      .push({ status: 429, headers: { 'Retry-After': '7' }, body: { error: { code: 'rate_limit_exceeded' } } })
      .push({ status: 503, headers: { 'Retry-After': inAMinute }, body: {} })
      .push({ status: 402, body: { error: { code: 'insufficient_credits' } } });

    const seconds = async (): Promise<unknown> => ((await outcome(api.request(EXECUTE))) as RateLimitError).retryAfterSeconds;

    expect(await seconds()).toBe(7);
    expect(await seconds()).toBeGreaterThanOrEqual(58);
    expect(await seconds()).toBeNull();
  });

  it('when the caller ends it during the pause', async () => {
    const caller = new AbortController();
    const reason = new Error('stop');
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      caller.abort(reason);

      throw new TypeError('socket hang up');
    }) as typeof fetch;
    const { api } = chain({ fetch: failing });

    expect(await outcome(api.request({ ...EXECUTE, signal: caller.signal }))).toBe(reason);
    expect(calls).toBe(1);
  });

  it('when the request cannot even be built', async () => {
    const { api, http } = chain();

    await expect(api.request({ ...EXECUTE, body: { n: 1n } })).rejects.toThrow(TypeError);
    expect(http.requests).toEqual([]);
  });
});

describe('an answer after no answer', () => {
  const DELETE = { method: 'DELETE', route: '/v1/customers/{externalUserId}', params: { externalUserId: 'user_1' } } as const;
  const GONE = { status: 404, body: { error: { code: 'customer_not_found' } } };

  it('is marked, so a call can tell that its first attempt may have gone through', async () => {
    const config = resolveConfig({ apiKey: 'sl_live_core', baseUrl: 'https://sdk.example', fetch: new FakeFetch().push(GONE).fetch });
    let calls = 0;
    const flaky = {
      send: async (request: Parameters<FetchClient['send']>[0]) => {
        calls += 1;

        if (calls === 1) {
          throw new ConnectionError('socket hang up');
        }

        return new FetchClient(config).send(request);
      },
    };
    const retrying = new RetryClient(flaky, new HttpJournal(NOOP_LOGGER), { retries: 2, pause: async () => undefined });

    expect(await retrying.send(DELETE)).toMatchObject({ status: 404, attempts: 2, afterNoAnswer: true });
  });

  it('is not marked after a 429 or a 503: those were answers', async () => {
    const http = new FakeFetch().push({ status: 503, headers: { 'Retry-After': '0' }, body: {} }).push(GONE);
    const config = resolveConfig({ apiKey: 'sl_live_core', baseUrl: 'https://sdk.example', fetch: http.fetch });
    const retrying = new RetryClient(new FetchClient(config), new HttpJournal(NOOP_LOGGER), { retries: 2, pause: async () => undefined });

    expect(await retrying.send(DELETE)).toMatchObject({ status: 404, attempts: 2, afterNoAnswer: false });
  });

  it('turns the code the request names into a success, and no other refusal', async () => {
    const { api, http } = chain({ timeoutMs: 20 });
    http.push({ delayMs: 1_000, body: {} }).push(GONE);

    expect(await api.request({ ...DELETE, doneAfterNoAnswer: 'customer_not_found' })).toBeUndefined();

    const plain = chain({ timeoutMs: 20 });
    plain.http.push({ delayMs: 1_000, body: {} }).push(GONE);

    expect(await outcome(plain.api.request(DELETE))).toMatchObject({ code: 'customer_not_found', status: 404 });
  });
});

describe('the pauses', () => {
  it('double from 200 ms up to 5 s, each within ±25 %', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((retried) => backoffMs(retried, () => 0.5))).toEqual([200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
    expect(backoffMs(0, () => 0)).toBe(150);
    expect(backoffMs(0, () => 1)).toBe(250);
  });

  it('never wait more than 5 s: the ceiling holds after the jitter', () => {
    expect(backoffMs(4, () => 1)).toBe(4_000);
    expect(backoffMs(5, () => 0)).toBe(4_800);
    expect(backoffMs(5, () => 1)).toBe(5_000);
    expect(backoffMs(30, () => 1)).toBe(5_000);
    expect(Math.max(...Array.from({ length: 200 }, (_, index) => backoffMs(index % 20, () => (index % 7) / 6)))).toBeLessThanOrEqual(5_000);
  });

  it('read Retry-After as seconds or as a date', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');

    expect(retryAfterMs('0', now)).toBe(0);
    expect(retryAfterMs(' 7 ', now)).toBe(7_000);
    expect(retryAfterMs('Sat, 17 Oct 2026 12:00:05 GMT', now)).toBe(5_000);
    expect(retryAfterMs('Sat, 17 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs('', now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });

  it('are really waited out by a client that is not a test double', async () => {
    const http = new FakeFetch()
      .push({ status: 503, headers: { 'Retry-After': '0' }, body: {} })
      .push({ body: { app: 'slen' } });
    const slen = new Slen({ apiKey: 'sl_live_core', baseUrl: 'https://sdk.example', fetch: http.fetch });

    expect(await slen.health()).toEqual({ app: 'slen' });
    expect(http.requests).toHaveLength(2);
  });

  it('end early when the caller aborts one', async () => {
    const http = new FakeFetch().push({ status: 503, headers: { 'Retry-After': '20' }, body: {} });
    const config = resolveConfig({ apiKey: 'sl_live_core', baseUrl: 'https://sdk.example', fetch: http.fetch });
    const retrying = new RetryClient(new FetchClient(config), new HttpJournal(NOOP_LOGGER), { retries: 2 });
    const caller = new AbortController();
    const reason = new Error('enough');
    const started = Date.now();

    setTimeout(() => caller.abort(reason), 20);

    expect(await outcome(retrying.send({ ...EXECUTE, signal: caller.signal }))).toBe(reason);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(http.requests).toHaveLength(1);
  });
});

describe('a wire that fails', () => {
  it('fails as a ConnectionError once every attempt has been made', async () => {
    let calls = 0;
    const failing = (async () => {
      calls += 1;

      throw new TypeError('ECONNREFUSED');
    }) as typeof fetch;
    const { api, pauses } = chain({ fetch: failing, retries: 2 });

    expect(await outcome(api.request(EXECUTE))).toBeInstanceOf(ConnectionError);
    expect(calls).toBe(3);
    expect(pauses).toEqual([200, 400]);
  });
});
