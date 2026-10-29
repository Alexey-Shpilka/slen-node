import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError, CustomerNotFoundError, InvalidRequestError, InvalidResponseError, type SlenError } from '../../src/errors.js';
import type { ExecutionTrace } from '../../src/modules/executions/types.js';
import { isCompleted, isFinished, isPending, nextDelayMs, pauseBefore, readTimeoutMs, waitMs } from '../../src/modules/executions/wait.js';
import { Slen } from '../../src/slen.js';
import { FakeFetch } from '../../src/testing/index.js';
import { outcome } from '../core/harness.js';
import { modules, queued, statusView } from './harness.js';

const ID = '74438200973594700';

const TRACE: ExecutionTrace = {
  execution_id: ID,
  flow_id: '74438200973590001',
  flow_version_id: '74438200973590101',
  flow_name: 'Support',
  operation: 'support.reply',
  operation_id: null,
  status: 'completed',
  error_code: null,
  error_message: null,
  cost: { estimated: '0.00412500', actual: '0.00398000' },
  cache: { hit: false, cached_at: null },
  started_at: '2026-10-17T12:00:00.000+00:00',
  finished_at: '2026-10-17T12:00:01.200+00:00',
  duration_ms: 1200,
  nodes: [],
  events: [],
};

const unavailable = { status: 503, body: { error: { code: 'service_unavailable' } } };
const broken = { status: 500, body: { error: { code: 'internal_error' } } };

describe('executions.get()', () => {
  it('reads the status view of the run once, with no span', async () => {
    const { executions, http, spans } = modules();
    http.push({ body: { data: statusView() } });

    expect(await executions.get(ID)).toEqual(statusView());
    expect(http.last()).toMatchObject({ method: 'GET', url: `https://sdk.example/api/v1/executions/${ID}/status`, body: null });
    expect(http.last()?.headers['idempotency-key']).toBeUndefined();
    expect(spans.spans).toEqual([]);
  });

  it('puts the id into its segment, and refuses a blank one before anything is sent', async () => {
    const { executions, http } = modules();
    http.push({ body: { data: statusView() } });

    await executions.get('7/4?x');
    expect(http.last()?.url).toBe('https://sdk.example/api/v1/executions/7%2F4%3Fx/status');

    for (const id of ['', '  ']) {
      expect(await outcome(executions.get(id))).toBeInstanceOf(InvalidRequestError);
    }

    expect(http.requests).toHaveLength(1);
  });

  it('repeats a read that got a 503, as the client repeats any', async () => {
    const { executions, http } = modules();
    http.push(unavailable).push({ body: { data: statusView() } });

    expect((await executions.get(ID)).status).toBe('completed');
    expect(http.requests).toHaveLength(2);
  });

  it('writes the route as its template, never the id', async () => {
    const { executions, http, records } = modules();
    http.push({ status: 404, body: { error: { code: 'not_found' } } });

    await outcome(executions.get('ada@example.com'));

    expect(JSON.stringify(records)).not.toContain('ada@example.com');
    expect(records.map((record) => record.context['route'])).toEqual(['/v1/executions/{id}/status', '/v1/executions/{id}/status']);
  });
});

describe('executions.trace()', () => {
  it('reads the trace of the run, with no span', async () => {
    const { executions, http, spans } = modules();
    http.push({ body: { data: TRACE } });

    expect(await executions.trace(ID)).toEqual(TRACE);
    expect(http.last()?.url).toBe(`https://sdk.example/api/v1/executions/${ID}`);
    expect(spans.spans).toEqual([]);
  });
});

describe('executions.wait()', () => {
  it('reads the run until it is over, at the pace the server asks for, and writes one span', async () => {
    const { executions, http, spans, clock } = modules();
    http
      .push({ body: { data: queued() } })
      .push({ body: { data: queued({ status: 'running', retry_after_seconds: 3 }) } })
      .push({ body: { data: statusView() } });

    const run = await executions.wait(ID);

    expect(run).toEqual(statusView());
    expect(http.requests.map((request) => request.url)).toEqual(Array(3).fill(`https://sdk.example/api/v1/executions/${ID}/status`));
    expect(clock.pauses).toEqual([2_000, 3_000]);
    expect(spans.spans).toEqual([
      {
        operation: 'executions.wait',
        outcome: 'ok',
        status: 'completed',
        durationMs: 5_000,
        executionId: ID,
        operationCode: 'support.reply',
        estimated: '0.00412500',
        actual: '0.00398000',
        errorCode: null,
        cacheHit: false,
      },
    ]);
  });

  it('journals every read with the pause that follows it', async () => {
    const { executions, http, records } = modules();
    http.push({ body: { data: queued() } }).push({ body: { data: statusView() } });

    await executions.wait(ID);

    expect(records.filter((record) => record.event.startsWith('slen.wait'))).toEqual([
      { level: 'debug', event: 'slen.wait.poll', context: { execution_id: ID, status: 'queued', next_poll_ms: 2_000 } },
      { level: 'debug', event: 'slen.wait.poll', context: { execution_id: ID, status: 'completed', next_poll_ms: null } },
    ]);
  });

  it('backs off from one second to thirty when the server names no pause', async () => {
    const { executions, http, clock } = modules();

    const unpaced = queued();
    delete unpaced.retry_after_seconds;

    for (let read = 0; read < 7; read += 1) {
      http.push({ body: { data: unpaced } });
    }

    http.push({ body: { data: statusView() } });

    await executions.wait(ID);

    expect(clock.pauses).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('jitters the pause by a quarter either way', () => {
    expect(nextDelayMs(4, 1, () => 0)).toBe(3_000);
    expect(nextDelayMs(4, 1, () => 1)).toBe(5_000);
    expect(nextDelayMs(undefined, 3, () => 0.5)).toBe(4_000);
    expect(nextDelayMs(Number.NaN, 1, () => 0.5)).toBe(1_000);
    expect(nextDelayMs(0, 1, () => 0.5)).toBe(250);
  });

  it('gives up at the timeout and answers the last state it read, still pending', async () => {
    const { executions, http, clock, spans } = modules();
    http.push({ body: { data: queued({ status: 'waiting', retry_after_seconds: 30 }) } });

    const run = await executions.wait(ID, { timeoutSeconds: 60 });

    expect(run.status).toBe('waiting');
    expect(clock.pauses).toEqual([30_000, 30_000]);
    expect(http.requests).toHaveLength(3);
    expect(spans.last()).toMatchObject({ outcome: 'ok', status: 'waiting', cacheHit: null, durationMs: 60_000 });
  });

  it('does not sleep past its timeout, whatever pause the server asked for', async () => {
    const { executions, http, clock } = modules();
    http.push({ body: { data: queued({ status: 'waiting', retry_after_seconds: 3_600 }) } });

    await executions.wait(ID, { timeoutSeconds: 10 });

    expect(clock.pauses).toEqual([10_000]);
    expect(http.requests).toHaveLength(2);
  });

  it.each([
    [undefined, 300_000],
    [Number.NaN, 300_000],
    [0, 1_000],
    [-5, 1_000],
    [2.5, 2_500],
    [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  ])('takes a timeout of %s seconds as %s ms', (seconds, ms) => {
    expect(waitMs(seconds)).toBe(ms);
  });

  it('holds a read to what is left of the wait, at least five seconds and at most the client clock', () => {
    const now = 1_000;

    expect(readTimeoutMs(65_000, now + 60_000, now)).toBe(60_000);
    expect(readTimeoutMs(65_000, now + 1_000, now)).toBe(5_000);
    expect(readTimeoutMs(65_000, now - 1_000, now)).toBe(5_000);
    expect(readTimeoutMs(2_000, now + 60_000, now)).toBe(2_000);
    expect(readTimeoutMs(65_000, Number.POSITIVE_INFINITY, now)).toBe(65_000);
    expect(readTimeoutMs(Number.NaN, now + 60_000, now)).toBe(60_000);
  });

  it('reads the time that is left as up when it is not a number', () => {
    expect(pauseBefore(Number.NaN, 0, 1_000)).toBeNull();
    expect(pauseBefore(1_000, 998, 1_000)).toBeNull();
    expect(pauseBefore(10_000, 0, Number.NaN)).toBe(250);
    expect(pauseBefore(10_000, 0, 60_000)).toBe(10_000);
  });

  it('outlives a 429, a 5xx and no answer, tells onPollError of each and reads the run to its end', async () => {
    const { executions, http, clock, records } = modules();
    const told: Array<[string, number]> = [];
    http
      .push({ status: 429, body: { error: { code: 'rate_limit_exceeded' } } })
      .push(broken)
      .push({ status: 504, text: '' })
      .push({ body: { data: statusView() } });

    const run = await executions.wait(ID, { onPollError: (error, inARow) => void told.push([error.name, inARow]) });

    expect(run.status).toBe('completed');
    expect(told).toEqual([
      ['RateLimitError', 1],
      ['ProviderError', 2],
      ['ProviderError', 3],
    ]);
    expect(clock.pauses).toEqual([1_000, 2_000, 4_000]);
    expect(records.filter((record) => record.event === 'slen.wait.poll_failed').map((record) => record.context)).toEqual([
      { execution_id: ID, failures_in_a_row: 1, error_type: 'RateLimit' },
      { execution_id: ID, failures_in_a_row: 2, error_type: 'Provider' },
      { execution_id: ID, failures_in_a_row: 3, error_type: 'Provider' },
    ]);
  });

  it('sends each read once: the wait repeats it, not the client', async () => {
    const { executions, http, retryPauses } = modules({ retries: 2 });
    http.push(unavailable).push({ body: { data: statusView() } });

    await executions.wait(ID);

    expect(http.requests).toHaveLength(2);
    expect(retryPauses).toEqual([]);
  });

  it('outlives a wire that fails on the very first read', async () => {
    const wire = new FakeFetch().push({ body: { data: statusView() } });
    let calls = 0;
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;

      if (calls === 1) {
        throw new TypeError('fetch failed');
      }

      return wire.fetch(input, init);
    }) as typeof fetch;
    const { executions, clock } = modules({ fetch: failing });

    expect((await executions.wait(ID)).status).toBe('completed');
    expect(calls).toBe(2);
    expect(clock.pauses).toEqual([1_000]);
  });

  it.each([
    [{ status: 404, body: { error: { code: 'customer_not_found' } } }, CustomerNotFoundError],
    [{ status: 401, body: { error: { code: 'invalid_api_key' } } }, AuthenticationError],
    [{ status: 200, text: 'not json' }, InvalidResponseError],
  ])('rejects at once with an error that waiting cannot fix: %j', async (answer, type) => {
    const { executions, http, clock, spans } = modules();
    http.push({ body: { data: queued() } }).push(answer);

    const error = await outcome(executions.wait(ID));

    expect(error).toBeInstanceOf(type);
    expect(clock.pauses).toEqual([2_000]);
    expect(spans.last()).toMatchObject({ operation: 'executions.wait', outcome: 'error', executionId: ID, operationCode: 'support.reply' });
  });

  it('answers the last state it read when the timeout is up during failures', async () => {
    const { executions, http, spans } = modules();
    http.push({ body: { data: queued() } }).push(broken);

    const run = await executions.wait(ID, { timeoutSeconds: 10 });

    expect(run.status).toBe('queued');
    expect(spans.last()).toMatchObject({ outcome: 'ok', status: 'queued' });
  });

  it('rejects with the last failure when the run could not be read even once, and its span names the run', async () => {
    const { executions, http, spans } = modules();
    http.push(broken);

    const error = await outcome(executions.wait(ID, { timeoutSeconds: 5 }));

    expect((error as SlenError).status).toBe(500);
    expect(spans.last()).toMatchObject({ outcome: 'error', status: null, executionId: ID, operationCode: null, errorCode: 'internal_error' });
  });

  it('ends a wait without a timeout after ten failed reads in a row', async () => {
    const { executions, http, clock } = modules();
    const told = vi.fn();
    http.push(unavailable);

    const error = await outcome(executions.wait(ID, { timeoutSeconds: Number.POSITIVE_INFINITY, onPollError: told }));

    expect((error as SlenError).status).toBe(503);
    expect(http.requests).toHaveLength(10);
    expect(told).toHaveBeenCalledTimes(10);
    expect(clock.pauses).toHaveLength(9);
  });

  it('starts that count over with every answer, so a flaky server is waited out', async () => {
    const { executions, http } = modules();

    for (let round = 0; round < 3; round += 1) {
      for (let failure = 0; failure < 9; failure += 1) {
        http.push(unavailable);
      }

      http.push({ body: { data: queued() } });
    }

    http.push({ body: { data: statusView() } });

    expect((await executions.wait(ID, { timeoutSeconds: Number.POSITIVE_INFINITY })).status).toBe('completed');
    expect(http.requests).toHaveLength(31);
  });

  it('does not count failures against a wait that has a timeout', async () => {
    const { executions, http } = modules();

    for (let failure = 0; failure < 12; failure += 1) {
      http.push(unavailable);
    }

    http.push({ body: { data: statusView() } });

    expect((await executions.wait(ID, { timeoutSeconds: 3_600 })).status).toBe('completed');
  });

  it('ends the wait with what onPollError throws', async () => {
    const { executions, http } = modules();
    const mine = new Error('stop waiting');
    http.push(unavailable);

    expect(
      await outcome(
        executions.wait(ID, {
          onPollError: () => {
            throw mine;
          },
        }),
      ),
    ).toBe(mine);
    expect(http.requests).toHaveLength(1);
  });

  it("ends on the caller's signal during a pause, with its reason", async () => {
    const { executions, http, clock } = modules();
    const controller = new AbortController();
    const reason = new Error('shutting down');
    http.push({ body: { data: queued() } });
    clock.sleep = async (): Promise<void> => {
      controller.abort(reason);
      throw reason;
    };

    expect(await outcome(executions.wait(ID, { signal: controller.signal }))).toBe(reason);
    expect(http.requests).toHaveLength(1);
  });

  it("ends on a signal that was aborted before, without reading", async () => {
    const { executions, http, spans } = modules();
    const controller = new AbortController();
    const reason = new Error('never mind');
    controller.abort(reason);

    expect(await outcome(executions.wait(ID, { signal: controller.signal }))).toBe(reason);
    expect(http.requests).toEqual([]);
    expect(spans.last()).toMatchObject({ outcome: 'error', executionId: ID });
  });

  it('refuses a blank id before anything is sent, with no span', async () => {
    const { executions, http, spans } = modules();

    expect(await outcome(executions.wait(' '))).toBeInstanceOf(InvalidRequestError);
    expect(http.requests).toEqual([]);
    expect(spans.spans).toEqual([]);
  });

  it('does not let a broken recorder break the wait', async () => {
    const http = new FakeFetch().push({ body: { data: statusView() } });
    const slen = new Slen({
      apiKey: 'sl_live_key',
      fetch: http.fetch,
      spanRecorder: {
        record(): void {
          throw new Error('the exporter is down');
        },
      },
    });

    expect((await slen.executions.wait(ID)).status).toBe('completed');
  });

  it('tells a run that is still going from one that is over', () => {
    expect(['queued', 'waiting', 'running'].map((status) => isPending(statusView({ status: status as 'queued' })))).toEqual([true, true, true]);
    expect(['completed', 'rejected', 'failed', 'uncertain'].map((status) => isPending(statusView({ status: status as 'completed' })))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('tells a run that is over from one still going, and a completed one from one that ended otherwise', () => {
    const statuses = ['queued', 'waiting', 'running', 'completed', 'rejected', 'failed', 'uncertain'] as const;

    expect(statuses.filter((status) => isFinished(statusView({ status })))).toEqual(['completed', 'rejected', 'failed', 'uncertain']);
    expect(statuses.filter((status) => isCompleted(statusView({ status })))).toEqual(['completed']);
  });
});
