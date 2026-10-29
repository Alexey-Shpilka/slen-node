import { describe, expect, it } from 'vitest';
import {
  InsufficientCreditsError,
  InvalidRequestError,
  PolicyDeniedError,
  ProviderError,
  ServiceUnavailableError,
  type SlenError,
} from '../../src/errors.js';
import { isRejected } from '../../src/modules/executions/wait.js';
import { Slen } from '../../src/slen.js';
import { FakeFetch } from '../../src/testing/index.js';
import { outcome } from '../core/harness.js';
import { execution, modules, SECRET_PROMPT } from './harness.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT = { messages: [{ role: 'user', content: 'Where is my order?' }] };

describe('operations.execute()', () => {
  it('runs the flow of the operation, with a generated key, and answers the run', async () => {
    const { operations, http } = modules();
    http.push({ body: { data: execution() } });

    const run = await operations.execute('support.reply', INPUT);

    expect(run).toEqual(execution());
    expect(http.requests).toHaveLength(1);
    expect(http.last()).toMatchObject({
      url: 'https://sdk.example/api/v1/operations/execute',
      method: 'POST',
      body: { operation: 'support.reply', input: INPUT },
    });
    expect(http.last()?.headers['idempotency-key']).toMatch(UUID_V4);
    expect(http.last()?.headers['content-type']).toBe('application/json');
  });

  it('sends the key the caller chose, the same on every attempt', async () => {
    const { operations, http, retryPauses } = modules();
    http.push({ status: 503, headers: { 'Retry-After': '1' }, body: { error: { code: 'service_unavailable' } } });
    http.push({ body: { data: execution() } });

    await operations.execute('support.reply', INPUT, { idempotencyKey: 'ticket-42:reply' });

    expect(http.requests.map((request) => request.headers['idempotency-key'])).toEqual(['ticket-42:reply', 'ticket-42:reply']);
    expect(retryPauses).toEqual([1_000]);
  });

  it('generates a new key for every call that names none', async () => {
    const { operations, http } = modules();
    http.push({ body: { data: execution() } });

    await operations.execute('support.reply', INPUT);
    await operations.execute('support.reply', INPUT);

    const [first, second] = http.requests.map((request) => request.headers['idempotency-key']);

    expect(first).not.toBe(second);
  });

  it.each(['', ' ', '\t\n'])('refuses an empty key (%j) before anything is sent, with no span and no journal', async (key) => {
    const { operations, http, spans, records } = modules();

    const error = await outcome(operations.execute('support.reply', INPUT, { idempotencyKey: key }));

    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as SlenError).code).toBe('invalid_request');
    expect(http.requests).toEqual([]);
    expect(spans.spans).toEqual([]);
    expect(records).toEqual([]);
  });

  it('refuses a timeout that is not above zero before anything is sent', async () => {
    const { operations, http, spans } = modules();

    expect(await outcome(operations.execute('support.reply', INPUT, { timeoutMs: 0 }))).toBeInstanceOf(InvalidRequestError);
    expect(http.requests).toEqual([]);
    expect(spans.spans).toEqual([]);
  });

  it('says nothing about the mode or the context when the caller did not ask', async () => {
    const { operations, http } = modules();
    http.push({ body: { data: execution() } });

    await operations.execute('support.reply', INPUT);

    expect(Object.keys(http.last()?.body ?? {})).toEqual(['operation', 'input']);
  });

  it('puts the customer and the credit type into the context, next to what the caller put there', async () => {
    const { operations, http } = modules();
    http.push({ body: { data: execution() } });

    await operations.execute('support.reply', INPUT, {
      customer: 'ada@example.com',
      creditType: 'images',
      context: { ticket: 42, channel: 'email' },
    });

    expect(http.last()?.body?.['context']).toEqual({ ticket: 42, channel: 'email', user_id: 'ada@example.com', credit_type: 'images' });
  });

  it('accepts the customer twice when both name the same one, a number read as its string', async () => {
    const { operations, http } = modules();
    http.push({ body: { data: execution() } });

    await operations.execute('support.reply', INPUT, { customer: '42', context: { user_id: 42 } });

    expect(http.last()?.body?.['context']).toEqual({ user_id: '42' });
  });

  it.each([
    [{ customer: 'ada', context: { user_id: 'grace' } }, 'customer'],
    [{ customer: 'ada', context: { user_id: null } }, 'customer'],
    [{ creditType: 'images', context: { credit_type: 'default' } }, 'creditType'],
  ])('refuses %j before anything is sent: the two name different values', async (options, option) => {
    const { operations, http, spans } = modules();

    const error = await outcome(operations.execute('support.reply', INPUT, options));

    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as Error).message).toContain(`\`${option}\``);
    expect(http.requests).toEqual([]);
    expect(spans.spans).toEqual([]);
  });

  it.each([
    [{ customer: '' }, 'customer'],
    [{ customer: '  ' }, 'customer'],
    [{ creditType: '' }, 'creditType'],
    [{ creditType: '\t' }, 'creditType'],
  ])('refuses %j before anything is sent: an empty value names nobody', async (options, option) => {
    const { operations, http, spans, records } = modules();

    const error = await outcome(operations.executeAsync('support.reply', INPUT, options));

    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as SlenError).code).toBe('invalid_request');
    expect((error as Error).message).toContain(`\`${option}\``);
    expect(http.requests).toEqual([]);
    expect(spans.spans).toEqual([]);
    expect(records).toEqual([]);
  });

  it('sends the context as the caller wrote it when no option claims a key of it', async () => {
    const { operations, http } = modules();
    http.push({ body: { data: execution() } });

    await operations.execute('support.reply', INPUT, { context: { user_id: 'ada' } });

    expect(http.last()?.body?.['context']).toEqual({ user_id: 'ada' });
  });

  it('writes one span under the name of the call, with the run it answered', async () => {
    const { operations, http, spans } = modules();
    http.push({ body: { data: execution({ cost: { estimated: '0.00412500', actual: null } }) } });

    await operations.execute('support.reply', INPUT);

    expect(spans.spans).toEqual([
      {
        operation: 'operations.execute',
        outcome: 'ok',
        status: 'completed',
        durationMs: expect.any(Number) as number,
        executionId: '74438200973594700',
        operationCode: 'support.reply',
        estimated: '0.00412500',
        actual: null,
        errorCode: null,
        cacheHit: false,
      },
    ]);
  });

  it('answers a run the flow parked with 202, and its span says waiting with nothing about the cache', async () => {
    const { operations, http, spans } = modules();
    const parked = execution({
      status: 'waiting',
      output: null,
      waiting_on: { node_key: 'approve', type: 'approval', resume_at: null },
      retry_after_seconds: 30,
    });
    http.push({ status: 202, body: { data: parked } });

    expect(await operations.execute('support.refund', INPUT)).toEqual(parked);
    expect(spans.last()).toMatchObject({ outcome: 'ok', status: 'waiting', cacheHit: null });
  });

  it('tells a refusal that came as an answer: 200, rejected, a refused span', async () => {
    const { operations, http, spans } = modules();
    const rejected = execution({
      status: 'rejected',
      output: null,
      error: { code: 'rejected_by_flow', message: 'Refunds over 100 need a person.' },
      error_code: 'rejected_by_flow',
      error_message: 'Refunds over 100 need a person.',
    });
    http.push({ body: { data: rejected } });

    const run = await operations.execute('support.refund', INPUT);

    expect(isRejected(run)).toBe(true);
    expect(spans.last()).toMatchObject({ outcome: 'refused', status: 'rejected', errorCode: 'rejected_by_flow', cacheHit: false });
  });

  it('raises a refusal of money as its typed error, and writes it as refused', async () => {
    const { operations, http, spans } = modules();
    http.push({ status: 402, body: { error: { code: 'insufficient_credits', message: 'The customer is out of credits.' } } });

    const error = await outcome(operations.execute('support.reply', INPUT, { customer: 'ada' }));

    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(spans.last()).toMatchObject({
      operation: 'operations.execute',
      outcome: 'refused',
      status: null,
      executionId: null,
      operationCode: 'support.reply',
      errorCode: 'insufficient_credits',
    });
  });

  it('writes a policy refusal as refused and a provider failure as an error, and repeats neither', async () => {
    const { operations, http, spans } = modules();
    http.push({ status: 403, body: { error: { code: 'policy_denied' } } });
    http.push({ status: 502, body: { error: { code: 'provider_error' } } });

    expect(await outcome(operations.execute('support.reply', INPUT))).toBeInstanceOf(PolicyDeniedError);
    expect(await outcome(operations.execute('support.reply', INPUT))).toBeInstanceOf(ProviderError);
    expect(spans.spans.map((span) => [span.outcome, span.errorCode])).toEqual([
      ['refused', 'policy_denied'],
      ['error', 'provider_error'],
    ]);
    expect(http.requests).toHaveLength(2);
  });

  it('gives up on a 503 after the retries, and its span says so', async () => {
    const { operations, http, spans } = modules({ retries: 1 });
    http.push({ status: 503, headers: { 'Retry-After': '0' }, body: { error: { code: 'ledger_unavailable' } } });

    expect(await outcome(operations.execute('support.reply', INPUT))).toBeInstanceOf(ServiceUnavailableError);
    expect(http.requests).toHaveLength(2);
    expect(spans.last()).toMatchObject({ outcome: 'error', errorCode: 'ledger_unavailable' });
  });

  it("ends at once on the caller's signal, with its reason and without a retry", async () => {
    const { operations, http, spans } = modules();
    const controller = new AbortController();
    const reason = new Error('the user left');
    http.push({ delayMs: 1_000, body: { data: execution() } });

    const pending = operations.execute('support.reply', INPUT, { signal: controller.signal });
    controller.abort(reason);

    expect(await outcome(pending)).toBe(reason);
    expect(http.requests).toHaveLength(1);
    expect(spans.last()).toMatchObject({ outcome: 'error', errorCode: null });
  });

  it('writes neither the prompt, the output, the key nor the customer to the span or the journal', async () => {
    const { operations, http, spans, records } = modules();
    http.push({
      body: { data: execution({ output: { content: SECRET_PROMPT }, error_message: SECRET_PROMPT }) },
    });

    await operations.execute(
      'support.reply',
      { messages: [{ role: 'user', content: SECRET_PROMPT }] },
      { customer: 'ada.secret@example.com', idempotencyKey: 'invoice-secret-7781', context: { note: SECRET_PROMPT } },
    );

    const written = JSON.stringify({ spans: spans.spans, records });

    for (const planted of [SECRET_PROMPT, 'ada.secret@example.com', 'invoice-secret-7781', 'sl_live_modules']) {
      expect(written).not.toContain(planted);
    }

    expect(records.map((record) => [record.event, record.context['route']])).toEqual([
      ['slen.request', '/v1/operations/execute'],
      ['slen.response', '/v1/operations/execute'],
    ]);
  });
});

describe('operations.executeAsync()', () => {
  it('asks for a worker and reads back the queued answer, under a span name of its own', async () => {
    const { operations, http, spans } = modules();
    const answer = execution({
      status: 'queued',
      output: null,
      cost: { estimated: null, actual: null },
      waiting_on: { node_key: 'start', type: 'async_dispatch', resume_at: null },
      retry_after_seconds: 2,
    });
    http.push({ status: 202, body: { data: answer } });

    expect(await operations.executeAsync('report.summarize', INPUT, { idempotencyKey: 'report-q3' })).toEqual(answer);
    expect(http.last()?.body).toEqual({ operation: 'report.summarize', input: INPUT, execution_mode: 'async' });
    expect(spans.last()).toMatchObject({ operation: 'operations.execute_async', status: 'queued', outcome: 'ok', cacheHit: null });
  });

  it('keeps the name when a replayed key answers with the run as it is now, cost and all', async () => {
    const { operations, http, spans } = modules();
    http.push({ body: { data: execution({ replayed: true, cost: { estimated: '0.004', actual: '0.003' } }) } });

    await operations.executeAsync('support.reply', INPUT, { idempotencyKey: 'ticket-42:reply' });

    expect(spans.last()).toMatchObject({ operation: 'operations.execute_async', status: 'completed', actual: '0.003', cacheHit: false });
  });

  it('keeps the name of a submission that was refused', async () => {
    const { operations, http, spans } = modules();
    http.push({ status: 402, body: { error: { code: 'budget_exceeded' } } });

    await outcome(operations.executeAsync('support.reply', INPUT));

    expect(spans.last()).toMatchObject({ operation: 'operations.execute_async', outcome: 'refused', errorCode: 'budget_exceeded' });
  });
});

describe('slen.operations', () => {
  it('runs on the chain of the client, against the hosted API', async () => {
    const http = new FakeFetch().push({ body: { data: execution() } });
    const slen = new Slen({ apiKey: 'sl_live_key', fetch: http.fetch });

    expect((await slen.operations.execute('support.reply', INPUT)).status).toBe('completed');
    expect(http.last()?.url).toBe('https://api.slen.ai/api/v1/operations/execute');
    expect(http.last()?.headers['authorization']).toBe('Bearer sl_live_key');
  });

  it('keeps the key out of what the client shows', () => {
    const slen = new Slen({ apiKey: 'sl_live_never_shown', fetch: new FakeFetch().fetch });

    expect(JSON.stringify(slen)).not.toContain('sl_live_never_shown');
    expect(Object.keys(slen).sort()).toEqual(['customers', 'executions', 'operations', 'webhooks']);
  });
});
