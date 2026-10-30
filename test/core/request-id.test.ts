import { describe, expect, it } from 'vitest';
import { InvalidRequestError, ServiceUnavailableError } from '../../src/errors.js';
import type { RequestOptions, WaitOptions } from '../../src/index.js';
import { Slen } from '../../src/slen.js';
import { FakeFetch, type QueuedResponse } from '../../src/testing/index.js';
import { trace } from '../fixtures.js';
import { account, customer, entry, execution, modules, price, queued, statusView } from '../modules/harness.js';
import { CONTRACT } from '../paths.js';
import { outcome, recordingLogger } from './harness.js';

interface NodeFs {
  readFileSync(path: URL, encoding: 'utf8'): string;
}

const NODE_FS: string = 'node:fs';
const fs = (await import(NODE_FS)) as NodeFs;

const HEALTH = { app: 'slen', release: null, server: 'octane', mysql: 'ok', redis: 'ok', queue: null, broadcast: null };
const PAGE = { limit: 50, next_cursor: null };
const DATA = (data: unknown): QueuedResponse => ({ body: { data } });

interface Answered {
  readonly answer: QueuedResponse;
  readonly call: (slen: Slen, options: RequestOptions) => Promise<object>;
}

/** Every call that reads an answer, with one it can read; each passes the options of a call where it takes them. */
const READS: Record<string, Answered> = {
  health: { answer: { body: HEALTH }, call: (slen, options) => slen.health(options) },
  'operations.execute': { answer: DATA(execution()), call: (slen, options) => slen.operations.execute('support.reply', { messages: [] }, options) },
  'operations.executeAsync': {
    answer: { status: 202, body: { data: execution({ status: 'queued', output: null }) } },
    call: (slen, options) => slen.operations.executeAsync('support.reply', { messages: [] }, options),
  },
  'executions.get': { answer: DATA(statusView()), call: (slen, options) => slen.executions.get('74438200973594700', options) },
  'executions.wait': { answer: DATA(statusView()), call: (slen) => slen.executions.wait('74438200973594700') },
  'executions.trace': { answer: DATA(trace()), call: (slen, options) => slen.executions.trace('74438200973594700', options) },
  'customers.list': { answer: { body: { data: [customer()], meta: PAGE } }, call: (slen, options) => slen.customers.list(options) },
  'customers.get': { answer: DATA(customer()), call: (slen, options) => slen.customers.get('user_8421', options) },
  'customers.create': { answer: DATA(customer()), call: (slen, options) => slen.customers.create('user_8421', options) },
  'customers.updateAccount': { answer: DATA(account()), call: (slen, options) => slen.customers.updateAccount('user_8421', 'default', options) },
  'customers.block': { answer: DATA(customer({ status: 'blocked' })), call: (slen, options) => slen.customers.block('user_8421', options) },
  'customers.unblock': { answer: DATA(customer()), call: (slen, options) => slen.customers.unblock('user_8421', options) },
  'customers.topUp': { answer: DATA(account()), call: (slen, options) => slen.customers.topUp('user_8421', '1', options) },
  'customers.charge': { answer: DATA(account()), call: (slen, options) => slen.customers.charge('user_8421', '1', options) },
  'customers.adjust': { answer: DATA(account()), call: (slen, options) => slen.customers.adjust('user_8421', '1', options) },
  'customers.entries': { answer: { body: { data: [entry()], meta: PAGE } }, call: (slen, options) => slen.customers.entries('user_8421', options) },
  'customers.prices': { answer: DATA([price()]), call: (slen, options) => slen.customers.prices(options) },
};

/** The calls of `contract/calls.json` that answer no body or many: `delete` is a 204, the loops give rows. */
const ANSWER_NO_ID = ['customers.delete', 'customers.entriesAll', 'customers.listAll'];

function client(answer: QueuedResponse, options: { retries?: number; headers?: Record<string, string> } = {}): { slen: Slen; http: FakeFetch } {
  const http = new FakeFetch().push(answer);

  return { slen: new Slen({ apiKey: 'sl_live_key', fetch: http.fetch, retries: 0, ...options }), http };
}

describe('the id of the response on an answer', () => {
  it('is on every call of contract/calls.json that reads one answer', () => {
    const calls = Object.keys((JSON.parse(fs.readFileSync(new URL('calls.json', CONTRACT), 'utf8')) as { calls: object }).calls);

    expect(Object.keys(READS).sort()).toEqual(calls.filter((call) => !ANSWER_NO_ID.includes(call)).sort());
  });

  it.each(Object.entries(READS))('%s carries X-Request-Id of its answer as _request_id, unseen by JSON and keys', async (_, read) => {
    const { slen } = client({ ...read.answer, headers: { 'X-Request-Id': 'req-answer-1' } });

    const answer = (await read.call(slen, {})) as object & { _request_id: string | null };

    expect(answer._request_id).toBe('req-answer-1');
    expect(Object.keys(answer)).not.toContain('_request_id');
    expect(JSON.stringify(answer)).not.toContain('req-answer-1');
    expect({ ...answer }).not.toHaveProperty('_request_id');
  });

  it.each(Object.entries(READS))('%s carries null when the answer has no X-Request-Id', async (_, read) => {
    const { slen } = client(read.answer);

    expect(((await read.call(slen, {})) as { _request_id: unknown })._request_id).toBeNull();
  });

  it('is on the answer, never on what it holds: the accounts of a customer have none', async () => {
    const { slen } = client({ ...DATA(customer()), headers: { 'X-Request-Id': 'req-customer' } });

    const read = await slen.customers.get('user_8421');

    expect(read._request_id).toBe('req-customer');
    expect(Object.hasOwn(read.accounts[0] as object, '_request_id')).toBe(false);
  });

  it('of a wait is the id of its last read', async () => {
    const { executions, http } = modules();
    http.push({ ...DATA(queued({ retry_after_seconds: 1 })), headers: { 'X-Request-Id': 'req-read-1' } });
    http.push({ ...DATA(statusView()), headers: { 'X-Request-Id': 'req-read-2' } });

    const run = await executions.wait('74438200973594700', { timeoutSeconds: 30 });

    expect(run.status).toBe('completed');
    expect(run._request_id).toBe('req-read-2');
    expect(http.requests).toHaveLength(2);
  });
});

describe('the caller\'s own request id', () => {
  it.each(Object.entries(READS).filter(([name]) => name !== 'executions.wait'))('%s sends requestId as X-Request-Id', async (_, read) => {
    const { slen, http } = client(read.answer);

    await read.call(slen, { requestId: 'order-42:call' });

    expect(http.last()?.headers['x-request-id']).toBe('order-42:call');
  });

  it('is sent by customers.delete as well', async () => {
    const { slen, http } = client({ status: 204 });

    await slen.customers.delete('user_8421', { requestId: 'order-42:delete' });

    expect(http.last()?.headers['x-request-id']).toBe('order-42:delete');
  });

  it('is not sent when the call has none', async () => {
    const { slen, http } = client({ body: HEALTH });

    await slen.health();

    expect(http.last()?.headers).not.toHaveProperty('x-request-id');
  });

  it('is the same on every attempt of the call: three attempts after two 503s, three times the one id', async () => {
    const unavailable = { status: 503, headers: { 'Retry-After': '0' }, body: { error: { code: 'service_unavailable' } } };
    const http = new FakeFetch().push(unavailable).push(unavailable).push(DATA(customer()));
    const slen = new Slen({ apiKey: 'sl_live_key', fetch: http.fetch, retries: 2 });

    await slen.customers.get('user_8421', { requestId: 'order-42:get' });

    expect(http.requests.map((request) => request.headers['x-request-id'])).toEqual(['order-42:get', 'order-42:get', 'order-42:get']);
  });

  it('is the id a refusal carries when the answer echoes it', async () => {
    const unavailable = { status: 503, headers: { 'X-Request-Id': 'order-42:get' }, body: { error: { code: 'service_unavailable' } } };
    const { slen } = client(unavailable);

    const error = await outcome(slen.customers.get('user_8421', { requestId: 'order-42:get' }));

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({ requestId: 'order-42:get' });
  });

  it('replaces an X-Request-Id the client sends with every request, for this call only', async () => {
    const { slen, http } = client({ body: HEALTH }, { headers: { 'x-request-id': 'client-wide-id' } });

    await slen.health({ requestId: 'order-42:health' });
    await slen.health();

    expect(http.requests.map((request) => request.headers['x-request-id'])).toEqual(['order-42:health', 'client-wide-id']);
  });

  it.each(['abcdefgh', 'A'.repeat(128), 'order-42:charge', 'job_7.attempt:1', '9c2d7e41-6b0a-4f3e-8d15-2a7f9e0c4b63'])(
    'takes %s: 8 to 128 of A-Z a-z 0-9 . _ : -',
    async (requestId) => {
      const { slen, http } = client({ body: HEALTH });

      await slen.health({ requestId });

      expect(http.last()?.headers['x-request-id']).toBe(requestId);
    },
  );

  it.each([
    ['short', 'short'],
    ['a space and a !', 'bad id!'],
    ['129 characters', 'a'.repeat(129)],
    ['an empty string', ''],
    ['a slash', 'order/42/charge'],
    ['a number from plain JavaScript', 42_000_000],
  ])('refuses %s before the wire: nothing sent, nothing written', async (_, requestId) => {
    const { logger, records } = recordingLogger();
    const http = new FakeFetch().push({ body: HEALTH });
    const slen = new Slen({ apiKey: 'sl_live_key', fetch: http.fetch, logger });

    const error = await outcome(slen.customers.get('user_8421', { requestId: requestId as string }));

    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error).toMatchObject({ code: 'invalid_request', status: null });
    expect((error as Error).message).toContain('requestId');
    expect(http.requests).toEqual([]);
    expect(records).toEqual([]);
  });

  it('is a string, and a wait takes none: a wait is many requests', () => {
    // @ts-expect-error — a request id is a string.
    const numeric: RequestOptions = { requestId: 1 };
    // @ts-expect-error — `WaitOptions` has no requestId: one id names one request.
    const wait: WaitOptions = { requestId: 'order-42:wait' };

    expect([numeric, wait]).toHaveLength(2);
  });
});
