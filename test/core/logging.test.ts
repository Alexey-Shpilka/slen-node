import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_EVENTS, NOOP_LOGGER, type SlenLogger } from '../../src/logger.js';
import { Slen } from '../../src/slen.js';
import { FakeFetch } from '../../src/testing/index.js';
import { chain, outcome, recordingLogger } from './harness.js';

const CHARGE = {
  method: 'POST',
  route: '/v1/customers/{externalUserId}/charge',
  params: { externalUserId: 'user_1' },
  body: { credits: '5.0000' },
  idempotencyKey: 'export-991:charge',
} as const;
const WHERE = { method: 'POST', route: '/v1/customers/{externalUserId}/charge' };

describe('the journal of a request', () => {
  it('names the events of the table, the same as the PHP SDK', () => {
    expect(Object.values(LOG_EVENTS)).toEqual([
      'slen.request',
      'slen.response',
      'slen.retry',
      'slen.refused',
      'slen.unauthorized',
      'slen.failed',
      'slen.wait.poll',
      'slen.wait.poll_failed',
      'slen.webhook.rejected',
    ]);
  });

  it('on a success: the request, then the response', async () => {
    const { api, http, records } = chain();
    http.push({ headers: { 'X-Request-Id': 'req-1' }, body: { data: { balance: '95.0000' } } });

    await api.request(CHARGE);

    expect(records).toEqual([
      { level: 'debug', event: 'slen.request', context: { ...WHERE, attempt: 1 } },
      { level: 'debug', event: 'slen.response', context: { ...WHERE, status: 200, duration_ms: expect.any(Number), request_id: 'req-1' } },
    ]);
    expect(records[1]?.context['duration_ms']).toBeGreaterThanOrEqual(0);
  });

  it('on a 402: the request, then the refusal at info', async () => {
    const { api, http, records } = chain();
    http.push({ status: 402, headers: { 'X-Request-Id': 'req-2' }, body: { error: { code: 'insufficient_credits', message: 'Not enough' } } });

    await outcome(api.request(CHARGE));

    expect(records).toEqual([
      { level: 'debug', event: 'slen.request', context: { ...WHERE, attempt: 1 } },
      { level: 'info', event: 'slen.refused', context: { ...WHERE, status: 402, error_code: 'insufficient_credits', request_id: 'req-2' } },
    ]);
  });

  it.each([
    [401, 'invalid_api_key'],
    [401, null],
    [403, 'insufficient_scope'],
    [403, 'not_a_member'],
    [403, null],
  ] as const)('on a %i %s: a key that cannot do it, at error', async (status, code) => {
    const { api, http, records } = chain();
    http.push({ status, body: code === null ? {} : { error: { code } } });

    await outcome(api.request(CHARGE));

    expect(records.at(-1)).toEqual({
      level: 'error',
      event: 'slen.unauthorized',
      context: { ...WHERE, status, error_code: code, request_id: null },
    });
  });

  it('on a 403 of a policy: a refusal, not a key to fix', async () => {
    const { api, http, records } = chain();
    http.push({ status: 403, body: { error: { code: 'policy_denied' } } });

    await outcome(api.request(CHARGE));

    expect(records.at(-1)).toMatchObject({ level: 'info', event: 'slen.refused' });
  });

  it('on a 503 that is repeated: the retry at warn, with the reason and the pause, then the second attempt', async () => {
    const { api, http, records } = chain();
    http.push({ status: 503, body: { error: { code: 'service_unavailable' } } }).push({ body: { data: {} } });

    await api.request(CHARGE);

    expect(records.map((record) => [record.level, record.event])).toEqual([
      ['debug', 'slen.request'],
      ['warn', 'slen.retry'],
      ['debug', 'slen.request'],
      ['debug', 'slen.response'],
    ]);
    expect(records[1]?.context).toEqual({ ...WHERE, attempt: 1, delay_ms: 200, reason: 'unavailable', status: 503 });
    expect(records[2]?.context).toEqual({ ...WHERE, attempt: 2 });
  });

  it('on a 429 that is repeated: the reason is the rate limit', async () => {
    const { api, http, records } = chain();
    http.push({ status: 429, headers: { 'Retry-After': '1' }, body: {} }).push({ body: { data: {} } });

    await api.request(CHARGE);

    expect(records[1]).toEqual({ level: 'warn', event: 'slen.retry', context: { ...WHERE, attempt: 1, delay_ms: 1_000, reason: 'rate_limited', status: 429 } });
  });

  it('on no answer at all: a retry for each, then the failure with how many attempts were made', async () => {
    const failing = (async () => {
      throw new TypeError('socket hang up');
    }) as typeof fetch;
    const { api, records } = chain({ fetch: failing, retries: 1 });

    await outcome(api.request(CHARGE));

    expect(records).toEqual([
      { level: 'debug', event: 'slen.request', context: { ...WHERE, attempt: 1 } },
      { level: 'warn', event: 'slen.retry', context: { ...WHERE, attempt: 1, delay_ms: 200, reason: 'no_answer', status: null } },
      { level: 'debug', event: 'slen.request', context: { ...WHERE, attempt: 2 } },
      {
        level: 'error',
        event: 'slen.failed',
        context: { ...WHERE, status: null, error_code: null, error_type: 'Connection', request_id: null, attempts: 2 },
      },
    ]);
  });

  it('on a 5xx: the failure, with the type it was raised as', async () => {
    const { api, http, records } = chain();
    http.push({ status: 504, headers: { 'X-Request-Id': 'req-5' }, body: { error: { code: 'operation_uncertain' } } });

    await outcome(api.request(CHARGE));

    expect(records.at(-1)).toEqual({
      level: 'error',
      event: 'slen.failed',
      context: { ...WHERE, status: 504, error_code: 'operation_uncertain', error_type: 'OperationUncertain', request_id: 'req-5', attempts: 1 },
    });
  });

  it('names the type as the error contract does, the same word as the PHP SDK', async () => {
    const provider = chain();
    provider.http.push({ status: 500, body: {} });
    await outcome(provider.api.request(CHARGE));

    const stalled = chain({ timeoutMs: 30, retries: 0 });
    stalled.http.push({ frames: ['{"data":', { text: '{}}', delayMs: 1_000 }] });
    await outcome(stalled.api.request(CHARGE));

    expect(provider.records.at(-1)?.context).toMatchObject({ status: 500, error_code: null, error_type: 'Provider', attempts: 1 });
    expect(stalled.records.at(-1)?.context).toMatchObject({ status: null, error_type: 'Timeout', attempts: 1 });
  });

  it('on a success that cannot be read: the failure', async () => {
    const { api, http, records } = chain();
    http.push({ text: '<html>proxy</html>' });

    await outcome(api.request(CHARGE));

    expect(records.at(-1)).toEqual({
      level: 'error',
      event: 'slen.failed',
      context: { ...WHERE, status: 200, error_code: 'invalid_response', error_type: 'InvalidResponse', request_id: null, attempts: 1 },
    });
  });
});

describe('what the journal never writes', () => {
  const SECRETS = {
    apiKey: 'sl_live_SECRET_API_KEY',
    idempotencyKey: 'SECRET_IDEMPOTENCY_KEY',
    externalUserId: 'secret.person@example.com',
    query: 'SECRET_QUERY_VALUE',
    prompt: 'SECRET_PROMPT_TEXT',
    output: 'SECRET_OUTPUT_TEXT',
    serverText: 'SECRET_SERVER_MESSAGE',
    webhookSecret: 'whsec_SECRET_WEBHOOK',
  };

  it('holds no key, secret, body, server text or value of the path or the query, on any path', async () => {
    const { logger, records } = recordingLogger();
    const http = new FakeFetch()
      .push({ body: { data: { output: SECRETS.output } } })
      .push({ status: 402, body: { error: { code: 'insufficient_credits', message: SECRETS.serverText, details: { note: SECRETS.output } } } })
      .push({ status: 503, body: { error: { code: 'service_unavailable', message: SECRETS.serverText } } })
      .push({ status: 500, body: { error: { code: 'provider_error', message: SECRETS.serverText } } })
      .push({ status: 401, body: { error: { code: 'invalid_api_key', message: SECRETS.serverText } } })
      .push({ text: `<html>${SECRETS.output}</html>` });
    const { api } = chainWith({ fetch: http.fetch, logger });
    const request = {
      method: 'POST',
      route: '/v1/customers/{externalUserId}/charge',
      params: { externalUserId: SECRETS.externalUserId },
      query: { tag: SECRETS.query },
      body: { messages: [{ role: 'user', content: SECRETS.prompt }] },
      idempotencyKey: SECRETS.idempotencyKey,
    } as const;

    for (let index = 0; index < 5; index += 1) {
      await outcome(api.request(request));
    }

    const written = JSON.stringify(records);

    expect(records.length).toBeGreaterThan(10);

    for (const [name, value] of Object.entries(SECRETS)) {
      expect(written.includes(value), name).toBe(false);
    }
  });

  function chainWith(options: { fetch: typeof fetch; logger: SlenLogger }): { api: ReturnType<typeof chain>['api'] } {
    const built = chain({ ...options, apiKey: SECRETS.apiKey, webhookSecret: SECRETS.webhookSecret, retries: 1 });

    return { api: built.api };
  }
});

describe('the logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('can be console as it is', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const http = new FakeFetch().push({ body: { app: 'slen' } });
    const slen = new Slen({ apiKey: 'sl_live_core', fetch: http.fetch, logger: console });

    await slen.health();

    expect(debug).toHaveBeenCalledWith('slen.request', { method: 'GET', route: '/health', attempt: 1 });
    expect(debug).toHaveBeenCalledWith('slen.response', expect.objectContaining({ method: 'GET', route: '/health', status: 200 }));
  });

  it('writes nowhere by default', async () => {
    const spies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    const http = new FakeFetch().push({ status: 500, body: {} });

    await outcome(new Slen({ apiKey: 'sl_live_core', fetch: http.fetch }).health());

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }

    expect(Object.isFrozen(NOOP_LOGGER)).toBe(true);
  });

  it('that throws does not fail the call it describes', async () => {
    const angry: SlenLogger = {
      debug: () => {
        throw new Error('disk full');
      },
      info: () => {
        throw new Error('disk full');
      },
      warn: () => {
        throw new Error('disk full');
      },
      error: () => {
        throw new Error('disk full');
      },
    };
    const http = new FakeFetch().push({ status: 503, headers: { 'Retry-After': '0' }, body: {} }).push({ body: { app: 'slen' } });

    expect(await new Slen({ apiKey: 'sl_live_core', fetch: http.fetch, logger: angry }).health()).toEqual({ app: 'slen' });
  });

  it('is called as a method, so a logger built on a class keeps its `this`', async () => {
    class Collecting implements SlenLogger {
      readonly lines: string[] = [];

      debug(message: string): void {
        this.lines.push(message);
      }

      info(message: string): void {
        this.lines.push(message);
      }

      warn(message: string): void {
        this.lines.push(message);
      }

      error(message: string): void {
        this.lines.push(message);
      }
    }

    const logger = new Collecting();
    const http = new FakeFetch().push({ body: { app: 'slen' } });

    await new Slen({ apiKey: 'sl_live_core', fetch: http.fetch, logger }).health();

    expect(logger.lines).toEqual(['slen.request', 'slen.response']);
  });
});
