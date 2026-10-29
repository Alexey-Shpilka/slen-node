import { describe, expect, it } from 'vitest';
import { Slen } from '../../src/slen.js';
import { execution } from '../modules/harness.js';
import { recordingLogger } from './harness.js';

/** The answer every request gets, with the request's own idempotency key as its X-Request-Id. */
function echo(): { fetch: typeof fetch; count: () => number } {
  let fetched = 0;
  const body = JSON.stringify({ data: execution() });
  const answer = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetched += 1;
    const key = new Headers(init?.headers).get('idempotency-key') ?? '';

    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Request-Id': key } });
  }) as typeof fetch;

  return { fetch: answer, count: () => fetched };
}

describe('a long-running server', () => {
  it('serves a thousand requests at once on one client, each journal in the logger of its own request', async () => {
    const http = echo();
    const shared = recordingLogger();
    const slen = new Slen({ apiKey: 'sl_live_worker', fetch: http.fetch, logger: shared.logger, retries: 0 });
    const requests = Array.from({ length: 1_000 }, (_, index) => ({ key: `request-${index}:reply`, ...recordingLogger() }));

    await Promise.all(
      requests.map(({ key, logger }) => slen.withLogger(logger).operations.execute('support.reply', { messages: [] }, { idempotencyKey: key })),
    );

    const strays = requests.flatMap(({ key, records }) =>
      records
        .filter((record) => (record.context['request_id'] ?? key) !== key)
        .map((record) => `${key} holds a record of ${String(record.context['request_id'])}`)
        .concat(records.length === 2 ? [] : [`${key} holds ${records.length} records`]),
    );

    expect(http.count()).toBe(1_000);
    expect(strays).toEqual([]);
    expect(shared.records).toEqual([]);
  });
});
