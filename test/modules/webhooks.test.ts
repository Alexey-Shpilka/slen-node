import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { InvalidResponseError, SlenError, WebhookSignatureError } from '../../src/errors.js';
import type {
  ApprovalDecidedEventData,
  CustomerBalanceLowEventData,
  ExecutionFinishedEventData,
  WebhookEvent,
} from '../../src/modules/webhooks/types.js';
import { WebhooksModule, webhooks } from '../../src/modules/webhooks/webhooks.js';
import { Slen } from '../../src/slen.js';
import { outcome, recordingLogger } from '../core/harness.js';
import { CONTRACT } from '../paths.js';

interface NodeFs {
  readFileSync(path: URL, encoding: 'utf8'): string;
}

const NODE_FS: string = 'node:fs';
const { readFileSync } = (await import(NODE_FS)) as NodeFs;

interface Vector {
  name: string;
  payload: string;
  header: string | null;
  now: number;
  valid: boolean;
  reason: string | null;
  event: { id: string; type: string } | null;
}

/** Signed by the Slen backend's own webhook signer; the PHP suite checks the same file. */
const VECTORS = JSON.parse(readFileSync(new URL('webhook-vectors.json', CONTRACT), 'utf8')) as {
  secret: string;
  tolerance_seconds: number;
  header_name: string;
  cases: Vector[];
};

const SECRET = VECTORS.secret;
const NOW = 1_792_238_400;

const at = (seconds: number): { now: Date } => ({ now: new Date(seconds * 1_000) });

/** Signs as the backend does: HMAC-SHA256 of `{t}.{body}` in lower-case hex, here with Web Crypto. */
async function sign(body: string | Uint8Array, secret = SECRET, t = NOW): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  const signed = new Uint8Array([...encoder.encode(`${t}.`), ...bytes]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));

  return `t=${t},v1=${Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function module(): { hooks: WebhooksModule; records: ReturnType<typeof recordingLogger>['records'] } {
  const { logger, records } = recordingLogger();

  return { hooks: new WebhooksModule({ secret: SECRET, toleranceSeconds: VECTORS.tolerance_seconds, logger }), records };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the webhook vectors of the contract', () => {
  it('are the file the backend signed, with every reason in it', () => {
    expect(VECTORS.header_name).toBe('Slen-Signature');
    expect(VECTORS.cases.length).toBeGreaterThan(30);
    expect(new Set(VECTORS.cases.map((vector) => vector.reason))).toEqual(
      new Set([null, 'missing_header', 'malformed_header', 'outside_tolerance', 'no_matching_signature']),
    );
  });

  it.each(VECTORS.cases)('$name: verify() answers $valid', async (vector) => {
    const { hooks, records } = module();

    expect(await hooks.verify(vector.payload, vector.header, at(vector.now))).toBe(vector.valid);
    expect(records.map((record) => record.context['reason'])).toEqual(vector.valid ? [] : [vector.reason]);
  });

  it.each(VECTORS.cases)('$name: the same over the raw bytes', async (vector) => {
    const { hooks } = module();

    expect(await hooks.verify(new TextEncoder().encode(vector.payload), vector.header, { secret: SECRET, ...at(vector.now) })).toBe(vector.valid);
  });

  it.each(VECTORS.cases)('$name: constructEvent() reads the event, or says why not', async (vector) => {
    const { hooks } = module();
    const result = await outcome(hooks.constructEvent(vector.payload, vector.header, at(vector.now)));

    if (!vector.valid) {
      expect(result).toBeInstanceOf(WebhookSignatureError);
      expect(result).toMatchObject({ code: 'webhook_signature_invalid', reason: vector.reason, status: null });

      return;
    }

    if (vector.event === null) {
      expect(result).toBeInstanceOf(InvalidResponseError);
      expect((result as SlenError).code).toBe('webhook_payload_invalid');

      return;
    }

    const event = (result as { resolved: WebhookEvent }).resolved;

    expect({ id: event.id, type: event.type }).toEqual(vector.event);
    expect(event).toEqual({ ...(JSON.parse(vector.payload) as object) });
  });

  it('checks every v1 with Web Crypto, in constant time, and never by comparing strings', async () => {
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const vector = VECTORS.cases.find((candidate) => candidate.name === 'two v1 values, the second one matches (a rotated secret)') as Vector;

    expect(await module().hooks.verify(vector.payload, vector.header, at(vector.now))).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls.every(([algorithm]) => algorithm === 'HMAC')).toBe(true);
  });
});

describe('webhooks.verify() and constructEvent()', () => {
  const body = JSON.stringify({
    id: '74438200973594901',
    type: 'execution.finished',
    created_at: '2026-10-17T12:00:00+00:00',
    data: { execution_id: '1', flow_id: '2', operation: 'support.reply', status: 'failed', error_code: 'provider_error' },
  });

  it('narrows the event by its type', async () => {
    const event = await module().hooks.constructEvent(body, await sign(body), at(NOW));

    if (event.type === 'execution.finished') {
      expectTypeOf(event.data).toEqualTypeOf<ExecutionFinishedEventData>();
      expect(event.data.error_code).toBe('provider_error');
    } else if (event.type === 'customer.balance_low') {
      expectTypeOf(event.data).toEqualTypeOf<CustomerBalanceLowEventData>();
    } else if (event.type === 'approval.decided') {
      expectTypeOf(event.data).toEqualTypeOf<ApprovalDecidedEventData>();
    } else if (event.type === 'budget.exceeded') {
      expectTypeOf(event.data).toEqualTypeOf<Readonly<Record<string, unknown>>>();
    }

    expect(event.type).toBe('execution.finished');
  });

  it('refuses a typed event whose data lacks a field it promises', async () => {
    const lacking = JSON.stringify({ ...(JSON.parse(body) as object), data: { execution_id: '1', status: 'completed' } });
    const { hooks, records } = module();

    expect(await outcome(hooks.constructEvent(lacking, await sign(lacking), at(NOW)))).toBeInstanceOf(InvalidResponseError);
    expect(records.map((record) => record.context)).toEqual([{ reason: 'invalid_payload', age_seconds: 0 }]);
  });

  it('reads an empty data the backend wrote as a list as an empty object', async () => {
    const empty = JSON.stringify({ id: '9', type: 'ledger.restored', created_at: '2026-10-17T12:00:00+00:00', data: [] });

    expect((await module().hooks.constructEvent(empty, await sign(empty), at(NOW))).data).toEqual({});
  });

  it.each([
    ['an envelope without created_at', { id: '9', type: 'ledger.restored', data: {} }],
    ['an id that is not text', { id: 9, type: 'ledger.restored', created_at: 'x', data: {} }],
    ['a data that is a list with items', { id: '9', type: 'ledger.restored', created_at: 'x', data: [1] }],
  ])('refuses %s as a body that is not an event', async (_what, envelope) => {
    const text = JSON.stringify(envelope);

    expect(await outcome(module().hooks.constructEvent(text, await sign(text), at(NOW)))).toMatchObject({
      code: 'webhook_payload_invalid',
    });
  });

  it('refuses bytes that are not UTF-8 even when they are signed', async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);

    expect(await module().hooks.verify(bytes, await sign(bytes), at(NOW))).toBe(true);
    expect(await outcome(module().hooks.constructEvent(bytes, await sign(bytes), at(NOW)))).toMatchObject({
      code: 'webhook_payload_invalid',
    });
  });

  it('takes the tolerance of the call over the one of the options', async () => {
    const { hooks } = module();
    const header = await sign(body, SECRET, NOW - 400);

    expect(await hooks.verify(body, header, at(NOW))).toBe(false);
    expect(await hooks.verify(body, header, { ...at(NOW), toleranceSeconds: 400 })).toBe(true);
    await expect(hooks.verify(body, header, { toleranceSeconds: 0 })).rejects.toThrow(RangeError);
  });

  it('holds the signature to the clock when no moment is given', async () => {
    const now = Math.floor(Date.now() / 1_000);

    expect(await module().hooks.verify(body, await sign(body, SECRET, now))).toBe(true);
    expect(await module().hooks.verify(body, await sign(body, SECRET, now - 3_600))).toBe(false);
  });

  it('takes the secret of the call over the one of the options, and refuses to check without one', async () => {
    const other = 'whsec_another_endpoint';
    const { hooks } = module();

    expect(await hooks.verify(body, await sign(body, other), { secret: other, ...at(NOW) })).toBe(true);
    expect(await hooks.verify(body, await sign(body, other), at(NOW))).toBe(false);

    for (const secret of ['', '   ']) {
      await expect(hooks.verify(body, await sign(body), { secret, ...at(NOW) })).rejects.toThrow(TypeError);
    }

    await expect(new WebhooksModule().verify(body, await sign(body), at(NOW))).rejects.toThrow(TypeError);
    await expect(new WebhooksModule({ secret: '  ' }).constructEvent(body, await sign(body), at(NOW))).rejects.toThrow(TypeError);
  });

  it('takes the secret in its options and nowhere else: a fourth argument does not compile', () => {
    const { hooks } = module();
    const verify = (): Promise<boolean> =>
      // @ts-expect-error — the secret is `secret` of the options, not an argument of its own.
      hooks.verify(body, 't=1,v1=00', SECRET, at(NOW));
    const construct = (): Promise<WebhookEvent> =>
      // @ts-expect-error — the same for constructEvent.
      hooks.constructEvent(body, 't=1,v1=00', SECRET, at(NOW));

    expect([hooks.verify.length, hooks.constructEvent.length]).toEqual([2, 2]);
    expect([typeof verify, typeof construct]).toEqual(['function', 'function']);
  });

  it('refuses a tolerance that is not a whole number of seconds, and a moment that is not one', async () => {
    for (const toleranceSeconds of [0, -1, 1.5, Number.NaN]) {
      expect(() => new WebhooksModule({ toleranceSeconds })).toThrow(RangeError);
    }

    await expect(module().hooks.verify(body, await sign(body), { now: new Date(Number.NaN) })).rejects.toThrow(TypeError);
  });

  it('writes the reason and the age of a refusal, and never the body, the header or the secret', async () => {
    const planted = JSON.stringify({ id: '1', type: 'ledger.degraded', created_at: 'x', data: { note: 'PLANTED-BODY' } });
    const notAnEvent = 'PLANTED-BODY, not JSON';
    const header = await sign(planted, SECRET, NOW - 301);
    const { hooks, records } = module();

    await outcome(hooks.constructEvent(planted, `${header},v1=PLANTEDSIGNATURE`, at(NOW)));
    await outcome(hooks.constructEvent(planted, header, { secret: 'whsec_PLANTED_SECRET', ...at(NOW - 301) }));
    await outcome(hooks.constructEvent(notAnEvent, await sign(notAnEvent), at(NOW)));

    expect(records).toEqual([
      { level: 'warn', event: 'slen.webhook.rejected', context: { reason: 'outside_tolerance', age_seconds: 301 } },
      { level: 'warn', event: 'slen.webhook.rejected', context: { reason: 'no_matching_signature', age_seconds: 0 } },
      { level: 'warn', event: 'slen.webhook.rejected', context: { reason: 'invalid_payload', age_seconds: 0 } },
    ]);

    const written = JSON.stringify(records);

    for (const value of ['PLANTED-BODY', 'PLANTEDSIGNATURE', 'PLANTED_SECRET', SECRET, header]) {
      expect(written).not.toContain(value);
    }
  });
});

describe('webhooks without a client, and slen.webhooks', () => {
  const body = JSON.stringify({ id: '7', type: 'flow.published', created_at: '2026-10-17T12:00:00+00:00', data: { flow_id: '1' } });

  it('need no API key: the module works on its own with the secret passed', async () => {
    expect((await webhooks.constructEvent(body, await sign(body), { secret: SECRET, ...at(NOW) })).type).toBe('flow.published');
    await expect(webhooks.verify(body, await sign(body), at(NOW))).rejects.toThrow(TypeError);
  });

  it('read the secret, the tolerance and the logger of the client', async () => {
    const { logger, records } = recordingLogger();
    const slen = new Slen({ apiKey: 'sl_live_key', webhookSecret: SECRET, webhookToleranceSeconds: 10, logger });

    expect(await slen.webhooks.verify(body, await sign(body), at(NOW + 10))).toBe(true);
    expect(await slen.webhooks.verify(body, await sign(body), at(NOW + 11))).toBe(false);
    expect(records.map((record) => record.event)).toEqual(['slen.webhook.rejected']);
  });
});
