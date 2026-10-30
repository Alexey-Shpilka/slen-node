import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  ConnectionError,
  InvalidRequestError,
  InvalidResponseError,
  ProviderError,
  type SlenError,
  TimeoutError,
} from '../../src/errors.js';
import { SDK_VERSION } from '../../src/version.js';
import { chain, outcome } from './harness.js';

interface NodeFs {
  readFileSync(path: URL, encoding: 'utf8'): string;
}

const NODE_FS: string = 'node:fs';
const fs = (await import(NODE_FS)) as NodeFs;
const NODE_VERSION = (globalThis as unknown as { process: { versions: { node: string } } }).process.versions.node;

const CUSTOMER = { method: 'GET', route: '/v1/customers/{externalUserId}', params: { externalUserId: 'user_1' } } as const;

describe('the request on the wire', () => {
  it('is the host root, /api, the route with its values encoded, and the query without what is undefined', async () => {
    const { api, http } = chain();
    http.push({ body: { data: { id: '1' } } });

    await api.request({
      method: 'GET',
      route: '/v1/customers/{externalUserId}/entries',
      params: { externalUserId: 'ann@example.com/a b' },
      query: { limit: 10, cursor: undefined, low: true },
    });

    expect(http.last()?.url).toBe('https://sdk.example/api/v1/customers/ann%40example.com%2Fa%20b/entries?limit=10&low=true');
    expect(http.last()?.method).toBe('GET');
  });

  it('carries the key, JSON, the idempotency key and the SDK name; the body is JSON', async () => {
    const { api, http } = chain();
    http.push({ body: { data: { id: '1' } } });

    await api.request({ method: 'POST', route: '/v1/operations/execute', body: { operation: 'support.reply' }, idempotencyKey: 'ticket-42:reply' });

    expect(http.last()?.headers).toEqual({
      authorization: 'Bearer sl_live_core',
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': 'ticket-42:reply',
      'user-agent': `slen-sdk-node/${SDK_VERSION} node/${NODE_VERSION}`,
    });
    expect(http.last()?.body).toEqual({ operation: 'support.reply' });
  });

  it('sends no Content-Type and no Idempotency-Key where there is no body and no key', async () => {
    const { api, http } = chain();
    http.push({ body: { data: {} } });

    await api.request(CUSTOMER);

    expect(Object.keys(http.last()?.headers ?? {}).sort()).toEqual(['accept', 'authorization', 'user-agent']);
  });

  it('adds the headers of the options, but never in place of its own; a User-Agent of the options replaces its own', async () => {
    const { api, http } = chain({
      headers: { 'X-Trace': 't-1', authorization: 'Bearer other', 'Idempotency-Key': 'other', 'user-agent': 'my-app/1.0' },
    });
    http.push({ body: { data: {} } });

    await api.request({ ...CUSTOMER, idempotencyKey: 'mine' });

    expect(http.last()?.headers).toEqual({
      'x-trace': 't-1',
      'user-agent': 'my-app/1.0',
      authorization: 'Bearer sl_live_core',
      accept: 'application/json',
      'idempotency-key': 'mine',
    });
  });

  it('names the version package.json has', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

    expect(SDK_VERSION).toBe(manifest.version);
  });
});

describe('a request refused before the wire', () => {
  it.each([
    ['an empty idempotency key', { ...CUSTOMER, idempotencyKey: '' }],
    ['a blank idempotency key', { ...CUSTOMER, idempotencyKey: '  ' }],
    ['a missing value of the route', { method: 'GET', route: '/v1/customers/{externalUserId}' }],
    ['an empty value of the route', { ...CUSTOMER, params: { externalUserId: ' ' } }],
    ['a timeout of zero', { ...CUSTOMER, timeoutMs: 0 }],
    ['negative retries', { ...CUSTOMER, retries: -1 }],
    ['retries that are not a whole number', { ...CUSTOMER, retries: 1.5 }],
    ['retries that are not a number', { ...CUSTOMER, retries: Number.NaN }],
  ] as const)('%s', async (_, request) => {
    const { api, http, records } = chain();

    const error = await outcome(api.request(request));

    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as SlenError).code).toBe('invalid_request');
    expect(http.requests).toEqual([]);
    expect(records).toEqual([]);
  });
});

describe('the answer', () => {
  it('is the data of the envelope', async () => {
    const { api, http } = chain();
    http.push({ body: { data: { external_user_id: 'user_1' }, meta: {} } });

    expect(await api.request(CUSTOMER)).toEqual({ external_user_id: 'user_1' });
  });

  it('is a list when the data is one', async () => {
    const { api, http } = chain();
    http.push({ body: { data: [{ operation_code: 'a' }] } });

    expect(await api.request({ method: 'GET', route: '/v1/credit-prices' })).toEqual([{ operation_code: 'a' }]);
  });

  it('is data and meta of a page, and nothing else of the body', async () => {
    const { api, http } = chain();
    http.push({ body: { data: [{ id: '1' }], meta: { limit: 1, next_cursor: '1' }, links: { next: '/x' } } });

    expect(await api.request({ method: 'GET', route: '/v1/customers', envelope: 'page' })).toEqual({
      data: [{ id: '1' }],
      meta: { limit: 1, next_cursor: '1' },
    });
  });

  it.each([
    ['page', { data: {}, meta: { next_cursor: null } }],
    ['page', { data: [], meta: { next_cursor: 1 } }],
    ['page', { data: [], meta: null }],
    ['list', { data: { operation_code: 'a' } }],
  ] as const)('of a %s that is not one is an InvalidResponseError', async (envelope, body) => {
    const { api, http } = chain();
    http.push({ body });

    expect(await outcome(api.request({ method: 'GET', route: '/v1/customers', envelope }))).toBeInstanceOf(InvalidResponseError);
    expect(http.requests).toHaveLength(1);
  });

  it('is the whole body where there is no envelope', async () => {
    const { api, http } = chain();
    http.push({ body: { app: 'slen', mysql: 'ok' } });

    expect(await api.request({ method: 'GET', route: '/health', envelope: false })).toEqual({ app: 'slen', mysql: 'ok' });
  });

  it('is nothing for a 204 of a call that answers no body', async () => {
    const { api, http } = chain();
    http.push({ status: 204 });

    expect(await api.requestNoContent({ method: 'DELETE', route: '/v1/customers/{externalUserId}', params: { externalUserId: 'user_1' } })).toBeUndefined();
  });

  it('of a call that reads an answer is an InvalidResponseError for a 204: there is nothing to read', async () => {
    const { api, http } = chain();
    http.push({ status: 204, headers: { 'X-Request-Id': 'req-204' } });

    const error = await outcome(api.request(CUSTOMER));

    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(error).toMatchObject({ code: 'invalid_response', status: 204, requestId: 'req-204' });
    expect((error as Error).message).toContain('no body');
  });

  it.each([
    ['no body', { text: '' }, 'no body'],
    ['a page', { text: '<html>proxy</html>', headers: { 'Content-Type': 'text/html' } }, 'a body that is not a JSON object'],
    ['a JSON list', { body: [1, 2] }, 'a body that is not a JSON object'],
    ['JSON without data', { body: { output: 'secret' } }, 'JSON that has no `data` in it'],
    ['data that is a string', { body: { data: 'secret' } }, 'JSON that has no `data` in it'],
  ] as const)('of a 2xx with %s is an InvalidResponseError, not repeated, the body not quoted', async (_, answer, what) => {
    const { api, http } = chain();
    http.push({ status: 200, ...answer, headers: { 'X-Request-Id': 'req-1', ...('headers' in answer ? answer.headers : {}) } });

    const error = await outcome(api.request(CUSTOMER));

    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(error).toMatchObject({ code: 'invalid_response', status: 200, requestId: 'req-1' });
    expect((error as Error).message).toContain(what);
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).not.toContain('proxy');
    expect(http.requests).toHaveLength(1);
  });

  it('of a refusal is its typed error, with the request id of the header', async () => {
    const { api, http } = chain();
    http.push({
      status: 402,
      headers: { 'X-Request-Id': 'req-402' },
      body: { error: { code: 'budget_exceeded', message: 'Over budget', details: { budget_id: '9' } } },
    });

    const error = await outcome(api.request(CUSTOMER));

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).toMatchObject({ code: 'budget_exceeded', status: 402, requestId: 'req-402', details: { budget_id: '9' }, message: 'Over budget' });
  });

  it('of a refusal takes the request id of the header, the one every answer carries, before the body', async () => {
    const { api, http } = chain();
    http.push({ status: 404, headers: { 'X-Request-Id': 'req-header' }, body: { error: { code: 'customer_not_found', request_id: 'req-body' } } });

    expect(await outcome(api.request(CUSTOMER))).toMatchObject({ requestId: 'req-header' });
  });

  it('of a refusal without the header takes the request id of the body', async () => {
    const { api, http } = chain();
    http.push({ status: 404, body: { error: { code: 'customer_not_found', request_id: 'req-body' } } });

    expect(await outcome(api.request(CUSTOMER))).toMatchObject({ requestId: 'req-body' });
  });

  it('of a 5xx that is not JSON is a ProviderError with no code', async () => {
    const { api, http } = chain();
    http.push({ status: 502, text: '<html>bad gateway</html>' });

    const error = await outcome(api.request(CUSTOMER));

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: null, status: 502 });
    expect(http.requests).toHaveLength(1);
  });
});

describe('no answer', () => {
  it('is a TimeoutError when the attempt clock runs out, with no code and no status', async () => {
    const { api, http } = chain({ timeoutMs: 20, retries: 0 });
    http.push({ delayMs: 1_000, body: { data: {} } });

    const error = await outcome(api.request(CUSTOMER));

    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ code: null, status: null });
    expect((error as Error).message).toBe('Slen did not answer GET /v1/customers/{externalUserId} within 20 ms.');
  });

  it('is a TimeoutError when the body stalls after the headers', async () => {
    const { api, http } = chain({ timeoutMs: 30, retries: 0 });
    http.push({ frames: ['{"data":', { text: '{}}', delayMs: 1_000 }] });

    expect(await outcome(api.request(CUSTOMER))).toBeInstanceOf(TimeoutError);
  });

  it('takes the timeout of the call over the one of the client', async () => {
    const { api, http } = chain({ timeoutMs: 5_000, retries: 0 });
    http.push({ delayMs: 1_000, body: { data: {} } });

    expect(await outcome(api.request({ ...CUSTOMER, timeoutMs: 20 }))).toBeInstanceOf(TimeoutError);
  });

  it('is a ConnectionError when the wire fails, naming the route and not its values', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const { api } = chain({ fetch: failing, retries: 0 });

    const error = await outcome(api.request({ ...CUSTOMER, params: { externalUserId: 'ann@example.com' } }));

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ code: null, status: null });
    expect((error as Error).message).toBe('Slen could not be reached for GET /v1/customers/{externalUserId}: fetch failed');
  });
});

describe('the caller ending the request', () => {
  it('rejects with the reason of the signal, and is not repeated', async () => {
    const { api, http } = chain({ retries: 2 });
    const caller = new AbortController();
    const reason = new Error('the user left');
    http.push({ delayMs: 1_000, body: { data: {} } });

    const pending = outcome(api.request({ ...CUSTOMER, signal: caller.signal }));
    setTimeout(() => caller.abort(reason), 10);

    expect(await pending).toBe(reason);
    expect(http.requests).toHaveLength(1);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const { api } = chain();
    const reason = new Error('too late');

    expect(await outcome(api.request({ ...CUSTOMER, signal: AbortSignal.abort(reason) }))).toBe(reason);
  });
});
