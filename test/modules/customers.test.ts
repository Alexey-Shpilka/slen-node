import { describe, expect, it } from 'vitest';
import {
  CustomerNotFoundError,
  IdempotencyConflictError,
  InsufficientCreditsError,
  InvalidRequestError,
  InvalidResponseError,
  type SlenError,
} from '../../src/errors.js';
import { Slen } from '../../src/slen.js';
import { FakeFetch } from '../../src/testing/index.js';
import { outcome } from '../core/harness.js';
import { account, customer, entry, modules, price } from './harness.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE = 'https://sdk.example/api';
// An external user id may be an email address: it is never written to the journal.
const EMAIL = 'ada@example.com';
const PAGE_META = { limit: 50, next_cursor: null };

describe('customers.list()', () => {
  it('asks for the page of customers, with every filter under its wire name, and answers data and meta', async () => {
    const { customers, http } = modules();
    const page = { data: [customer()], meta: { limit: 20, next_cursor: '74438200973594624' } };
    http.push({ body: page });

    const answer = await customers.list({
      cursor: 'abc',
      limit: 20,
      search: 'user_84',
      status: 'blocked',
      creditType: 'images',
      lowBalance: '10',
    });

    expect(answer).toEqual(page);

    const url = new URL(http.last()?.url ?? '');

    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/v1/customers`);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, name) => {
      query[name] = value;
    });

    expect(query).toEqual({
      view: 'customers',
      cursor: 'abc',
      limit: '20',
      q: 'user_84',
      status: 'blocked',
      credit_type: 'images',
      low_balance: '10',
    });
    expect(http.last()?.headers['idempotency-key']).toBeUndefined();
  });

  it('always sends view=customers (without it the server answers the page of accounts) and the page size', async () => {
    const { customers, http } = modules();
    http.push({ body: { data: [], meta: PAGE_META } });

    expect(await customers.list()).toEqual({ data: [], meta: PAGE_META });
    expect(http.last()?.url).toBe(`${BASE}/v1/customers?view=customers&limit=50`);
  });

  it.each([
    ['no meta', { data: [] }],
    ['a meta without next_cursor', { data: [], meta: { limit: 50 } }],
    ['a cursor that is a number', { data: [], meta: { limit: 50, next_cursor: 7 } }],
    ['data that is not a list', { data: customer(), meta: PAGE_META }],
  ])('refuses a page with %s as InvalidResponseError, sent once', async (_what, body) => {
    const { customers, http } = modules();
    http.push({ body });

    const error = await outcome(customers.list());

    expect(error).toBeInstanceOf(InvalidResponseError);
    expect((error as SlenError).code).toBe('invalid_response');
    expect(http.requests).toHaveLength(1);
  });
});

describe('customers.get(), create(), block(), unblock()', () => {
  it('reads one customer, its id encoded into its segment', async () => {
    const { customers, http } = modules();
    http.push({ body: { data: customer({ external_user_id: EMAIL }) } });

    expect(await customers.get(EMAIL)).toEqual(customer({ external_user_id: EMAIL }));
    expect(http.last()).toMatchObject({ method: 'GET', url: `${BASE}/v1/customers/ada%40example.com`, body: null });
  });

  it('raises an unknown customer as CustomerNotFoundError', async () => {
    const { customers, http } = modules();
    http.push({ status: 404, body: { error: { code: 'customer_not_found', message: 'No such customer.' } } });

    expect(await outcome(customers.get('user_1'))).toBeInstanceOf(CustomerNotFoundError);
  });

  it.each([201, 200])('creates with PUT and an empty body, no key: %i answers the customer', async (status) => {
    const { customers, http } = modules();
    http.push({ status, body: { data: customer({ accounts: [] }) } });

    expect(await customers.create('user_8421')).toEqual(customer({ accounts: [] }));
    expect(http.last()).toMatchObject({ method: 'PUT', url: `${BASE}/v1/customers/user_8421`, body: {} });
    expect(http.last()?.headers['idempotency-key']).toBeUndefined();
  });

  it('blocks with the reason when one is given, with an empty body when not', async () => {
    const { customers, http } = modules();
    const blocked = customer({ status: 'blocked', blocked_at: '2026-10-17T11:00:00+00:00', block_reason: 'Chargeback' });
    http.push({ body: { data: blocked } });

    expect(await customers.block('user_8421', { reason: 'Chargeback' })).toEqual(blocked);
    expect(http.last()).toMatchObject({ method: 'POST', url: `${BASE}/v1/customers/user_8421/block`, body: { reason: 'Chargeback' } });

    await customers.block('user_8421');

    expect(http.last()?.body).toEqual({});
  });

  it('unblocks with an empty body', async () => {
    const { customers, http } = modules();
    http.push({ body: { data: customer() } });

    expect(await customers.unblock('user_8421')).toEqual(customer());
    expect(http.last()).toMatchObject({ method: 'POST', url: `${BASE}/v1/customers/user_8421/unblock`, body: {} });
  });
});

describe('customers.updateAccount()', () => {
  it('puts the whole of the settings on the account of the credit type', async () => {
    const { customers, http } = modules();
    http.push({ status: 201, body: { data: account({ credit_type: 'images', allow_negative: true }) } });

    const answer = await customers.updateAccount('user_8421', 'images', { allowNegative: true, lowBalanceThreshold: '10.0000' });

    expect(answer).toEqual(account({ credit_type: 'images', allow_negative: true }));
    expect(http.last()).toMatchObject({
      method: 'PUT',
      url: `${BASE}/v1/customers/user_8421/accounts/images`,
      body: { allow_negative: true, low_balance_threshold: '10.0000' },
    });
    expect(http.last()?.headers['idempotency-key']).toBeUndefined();
  });

  it('puts back the defaults of what is left out: no overdraft, no warning', async () => {
    const { customers, http } = modules();
    http.push({ body: { data: account() } });

    await customers.updateAccount('user_8421', 'default');

    expect(http.last()?.body).toEqual({ allow_negative: false, low_balance_threshold: '0' });
  });

  it.each(['', ' '])('refuses an empty credit type (%j) before anything is sent', async (creditType) => {
    const { customers, http, records } = modules();

    expect(await outcome(customers.updateAccount('user_8421', creditType))).toBeInstanceOf(InvalidRequestError);
    expect(http.requests).toEqual([]);
    expect(records).toEqual([]);
  });
});

describe('customers.delete()', () => {
  it('deletes and answers nothing on a 204', async () => {
    const { customers, http } = modules();
    http.push({ status: 204 });

    expect(await customers.delete('user_8421')).toBeUndefined();
    expect(http.last()).toMatchObject({ method: 'DELETE', url: `${BASE}/v1/customers/user_8421`, body: null });
  });

  it('raises a customer with history as the refusal it is: 409 customer_has_history', async () => {
    const { customers, http } = modules();
    http.push({ status: 409, body: { error: { code: 'customer_has_history', message: 'Block the customer instead.' } } });

    const error = await outcome(customers.delete('user_8421'));

    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error).toMatchObject({ code: 'customer_has_history', status: 409 });
  });

  it('raises an unknown customer as CustomerNotFoundError when every attempt was answered', async () => {
    const { customers, http } = modules();
    http
      .push({ status: 503, headers: { 'Retry-After': '1' }, body: { error: { code: 'service_unavailable' } } })
      .push({ status: 404, body: { error: { code: 'customer_not_found' } } });

    expect(await outcome(customers.delete('user_8421'))).toBeInstanceOf(CustomerNotFoundError);
    expect(http.requests).toHaveLength(2);
  });

  it('is done when the repeat after no answer finds no customer: the first attempt deleted it', async () => {
    const { customers, http, records } = modules({ timeoutMs: 20 });
    http.push({ delayMs: 1_000, body: {} }).push({ status: 404, body: { error: { code: 'customer_not_found' } } });

    expect(await customers.delete('user_8421')).toBeUndefined();
    expect(http.requests.map((request) => request.method)).toEqual(['DELETE', 'DELETE']);
    expect(records.at(-1)).toMatchObject({ event: 'slen.response', context: { route: '/v1/customers/{externalUserId}', status: 404 } });
  });

  it('still refuses any other answer to the repeat after no answer', async () => {
    const { customers, http } = modules({ timeoutMs: 20 });
    http.push({ delayMs: 1_000, body: {} }).push({ status: 409, body: { error: { code: 'customer_has_history' } } });

    expect(await outcome(customers.delete('user_8421'))).toMatchObject({ code: 'customer_has_history' });
  });

  it('does not take a 404 of another code for done', async () => {
    const { customers, http } = modules({ timeoutMs: 20 });
    http.push({ delayMs: 1_000, body: {} }).push({ status: 404, body: { error: { code: 'not_found' } } });

    expect(await outcome(customers.delete('user_8421'))).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe.each([
  ['topUp', 'topup', '100.0000'],
  ['charge', 'charge', '5.0000'],
  ['adjust', 'adjust', '-2.5'],
] as const)('customers.%s()', (method, path, credits) => {
  it('moves the credits on the default account under a generated key', async () => {
    const { customers, http } = modules();
    http.push({ body: { data: account() } });

    expect(await customers[method]('user_8421', credits)).toEqual(account());
    expect(http.last()).toMatchObject({ method: 'POST', url: `${BASE}/v1/customers/user_8421/${path}` });
    expect(http.last()?.body).toEqual({ credits, credit_type: 'default' });
    expect(http.last()?.headers['idempotency-key']).toMatch(UUID_V4);
  });

  it('sends the credit type, the note and the chosen key, the same key on every attempt', async () => {
    const { customers, http } = modules();
    http
      .push({ status: 503, headers: { 'Retry-After': '1' }, body: { error: { code: 'ledger_unavailable' } } })
      .push({ body: { data: account({ credit_type: 'images' }) } });

    await customers[method]('user_8421', credits, { creditType: 'images', note: 'invoice 7781', idempotencyKey: 'invoice-7781' });

    expect(http.last()?.body).toEqual({ credits, credit_type: 'images', note: 'invoice 7781' });
    expect(http.requests.map((request) => request.headers['idempotency-key'])).toEqual(['invoice-7781', 'invoice-7781']);
  });

  it('raises a key that names another movement as IdempotencyConflictError', async () => {
    const { customers, http } = modules();
    http.push({ status: 409, body: { error: { code: 'idempotency_conflict' } } });

    expect(await outcome(customers[method]('user_8421', credits, { idempotencyKey: 'invoice-7781' }))).toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it.each([
    ['an empty customer', ['', credits, {}]],
    ['a blank customer', [' ', credits, {}]],
    ['an empty credit type', ['user_8421', credits, { creditType: '' }]],
    ['a blank key', ['user_8421', credits, { idempotencyKey: ' ' }]],
    ['credits that are a number', ['user_8421', 5 as unknown as string, {}]],
    ['credits with five decimal places', ['user_8421', '1.00001', {}]],
    ['credits in another notation', ['user_8421', '1e3', {}]],
    ['credits with a comma', ['user_8421', '1,5', {}]],
    ['credits with no digit before the point', ['user_8421', '.5', {}]],
    ['zero credits', ['user_8421', '0.0000', {}]],
    ['negative zero', ['user_8421', '-0', {}]],
  ] as const)('refuses %s before anything is sent, with no journal', async (_what, args) => {
    const { customers, http, records } = modules();

    const error = await outcome(customers[method](...(args as [string, string, Record<string, string>])));

    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as SlenError).code).toBe('invalid_request');
    expect(http.requests).toEqual([]);
    expect(records).toEqual([]);
  });
});

describe('the sign of the credits', () => {
  it.each([
    ['topUp', '-5'],
    ['charge', '-5.0000'],
  ] as const)('%s refuses %s: it moves one way only', async (method, credits) => {
    const { customers, http } = modules();

    expect(await outcome(customers[method]('user_8421', credits))).toBeInstanceOf(InvalidRequestError);
    expect(http.requests).toEqual([]);
  });

  it.each(['5', '0.0001', '-0.0001', '-1250.5'])('adjust takes %s', async (credits) => {
    const { customers, http } = modules();
    http.push({ body: { data: account() } });

    await customers.adjust('user_8421', credits);

    expect(http.last()?.body).toEqual({ credits, credit_type: 'default' });
  });

  it('charge raises an account that cannot cover it as InsufficientCreditsError', async () => {
    const { customers, http } = modules();
    http.push({ status: 402, body: { error: { code: 'insufficient_credits', message: 'Not enough credits.' } } });

    expect(await outcome(customers.charge('user_8421', '5'))).toBeInstanceOf(InsufficientCreditsError);
  });
});

describe('customers.entries() and prices()', () => {
  it('reads one page of the statement with every filter under its wire name', async () => {
    const { customers, http } = modules();
    const page = { data: [entry()], meta: { limit: 10, next_cursor: '74438200973594800' } };
    http.push({ body: page });

    expect(await customers.entries('user_8421', { cursor: 'c1', limit: 10, creditType: 'images', entryType: 'charge' })).toEqual(page);
    expect(http.last()?.url).toBe(`${BASE}/v1/customers/user_8421/entries?cursor=c1&limit=10&credit_type=images&entry_type=charge`);

    await customers.entries('user_8421');

    expect(http.last()?.url).toBe(`${BASE}/v1/customers/user_8421/entries?limit=50`);
  });

  it('reads the price list, filtered by equality', async () => {
    const { customers, http } = modules();
    http.push({ body: { data: [price()] } });

    expect(await customers.prices({ operationCode: 'support.reply', creditType: 'default' })).toEqual([price()]);
    expect(http.last()?.url).toBe(`${BASE}/v1/credit-prices?operation_code=support.reply&credit_type=default`);
  });

  it('refuses a price list that is not a list', async () => {
    const { customers, http } = modules();
    http.push({ body: { data: price() } });

    expect(await outcome(customers.prices())).toBeInstanceOf(InvalidResponseError);
  });
});

describe('what the customers module leaves behind', () => {
  it('writes no span: moving credits is not a run', async () => {
    const { customers, http, spans } = modules();
    http.push({ body: { data: account() } });

    await customers.topUp('user_8421', '1');
    await customers.charge('user_8421', '1');
    await customers.adjust('user_8421', '1');

    expect(spans.spans).toEqual([]);
  });

  it('writes the route as its template, never the customer, the note or the key', async () => {
    const { customers, http, records } = modules();
    http.push({ body: { data: account() } });

    await customers.charge(EMAIL, '1', { note: 'secret note', idempotencyKey: 'secret-key-1' });

    const text = JSON.stringify(records);

    expect(records.map((record) => record.event)).toEqual(['slen.request', 'slen.response']);
    expect(records[0]?.context).toMatchObject({ route: '/v1/customers/{externalUserId}/charge' });
    expect(text).not.toContain('ada');
    expect(text).not.toContain('secret');
  });

  it('is a module of the client, with the client options', async () => {
    const http = new FakeFetch().push({ body: { data: customer() } });
    const slen = new Slen({ apiKey: 'sl_live_customers', baseUrl: 'https://sdk.example', fetch: http.fetch });

    expect(Object.keys(slen)).toContain('customers');
    expect(await slen.customers.get('user_8421')).toEqual(customer());
    expect(http.last()?.headers['authorization']).toBe('Bearer sl_live_customers');
  });
});
