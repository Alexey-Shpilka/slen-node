import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';
import type {
  AccountOptions,
  CallOptions,
  Customer,
  CustomerListOptions,
  EntryListOptions,
  ExecutionResult,
  PriceListOptions,
  QueuedFrame,
  RequestOptions,
  VerifyOptions,
  WebhookEvent,
} from '../src/index.js';

/**
 * The runtime surface of `@slen/sdk`, name by name. Nothing is published yet, so
 * this is the moment it is cheap to keep it exact: a value that joins or leaves
 * `src/index.ts` joins or leaves this list in the same change.
 */
describe('the public surface of @slen/sdk', () => {
  it('exports exactly these values', () => {
    expect(Object.keys(sdk).sort()).toEqual(
      [
        'AuthenticationError',
        'BudgetExceededError',
        'ConcurrencyLimitError',
        'ConnectionError',
        'CustomerBlockedError',
        'CustomerNotFoundError',
        'CustomersModule',
        'DEFAULT_BASE_URL',
        'ExecutionsModule',
        'FakeFetch',
        'FlowRuntimeError',
        'INVALID_REQUEST',
        'INVALID_RESPONSE',
        'IdempotencyConflictError',
        'InsufficientCreditsError',
        'InvalidRequestError',
        'InvalidResponseError',
        'LOG_EVENTS',
        'LoggerSpanRecorder',
        'MemorySpanRecorder',
        'MultiSpanRecorder',
        'NOOP_LOGGER',
        'NullSpanRecorder',
        'OperationLimitExceededError',
        'OperationUncertainError',
        'OperationsModule',
        'OtelSpanRecorder',
        'OtlpSpanRecorder',
        'OverrunApprovalRequiredError',
        'OverrunStoppedError',
        'PolicyDeniedError',
        'ProviderError',
        'RateLimitError',
        'SPAN_ATTRIBUTE_NAMES',
        'SPAN_FIELDS',
        'SPAN_OPERATIONS',
        'ServiceUnavailableError',
        'Slen',
        'SlenError',
        'SpendRefusedError',
        'TimeoutError',
        'WEBHOOK_EVENT_TYPES',
        'WEBHOOK_PAYLOAD_INVALID',
        'WEBHOOK_SIGNATURE_INVALID',
        'WebhookSignatureError',
        'WebhooksModule',
        'apiBase',
        'errorFromResponse',
        'generateIdempotencyKey',
        'idempotencyKeyForJob',
        'isCompleted',
        'isFinished',
        'isPending',
        'isRejected',
        'otelSpanRecorder',
        'resolveConfig',
        'spanAttributes',
        'webhooks',
      ].sort(),
    );
  });

  it('exports nothing of the gateway: no hold, no chat, no stream, no OpenAI wrapper', () => {
    for (const name of [
      'AuthorizationsResource',
      'ChatResource',
      'ChatStream',
      'CostEstimatesResource',
      'ResponsesResource',
      'OperationsResource',
      'CustomersResource',
      'Transport',
      'readSseFrames',
      'wrapOpenAI',
      'ReservationExpiredError',
      'UnsupportedByGatewayError',
      'RESERVATION_ID_HEADER',
      'STREAM_IDLE_TIMEOUT',
      'SpanScope',
    ]) {
      expect(name in sdk, name).toBe(false);
    }

    // The type aliases are gone too; each line stops compiling if one comes back.
    // @ts-expect-error — `ChatCompletion` left with the gateway.
    const completion: sdk.ChatCompletion | undefined = undefined;
    // @ts-expect-error — `Reservation` left with the holds.
    const reservation: sdk.Reservation | undefined = undefined;

    expect([completion, reservation]).toEqual([undefined, undefined]);
  });

  it('puts a blocked customer under the policy refusals and a refused signature under SlenError', () => {
    expect(new sdk.CustomerBlockedError('blocked')).toBeInstanceOf(sdk.PolicyDeniedError);
    expect(new sdk.WebhookSignatureError('bad', { reason: 'missing_header' })).toBeInstanceOf(sdk.SlenError);
  });

  it('exports the types a caller names: options, wire shapes, events, the doubles', () => {
    const options: CallOptions & RequestOptions = { idempotencyKey: 'k', timeoutMs: 1, retries: 0 };
    const frame: QueuedFrame | null = null;
    const shapes: Array<Customer | ExecutionResult | WebhookEvent> = [];

    expect([options.idempotencyKey, frame, shapes]).toEqual(['k', null, []]);
    expect(sdk.INVALID_RESPONSE).toBe('invalid_response');
    expect(sdk.webhooks).toBeInstanceOf(sdk.WebhooksModule);
  });

  it('names the options of a call as the PHP SDK names its classes, and keeps no earlier name', () => {
    const list: CustomerListOptions = { limit: 10, retries: 0 };
    const account: AccountOptions = { allowNegative: true };
    const entries: EntryListOptions = { entryType: 'charge' };
    const prices: PriceListOptions = { operationCode: 'support.reply' };
    const verify: VerifyOptions = { secret: 'whsec_x', toleranceSeconds: 60 };

    // @ts-expect-error — `CustomerListFilters` is `CustomerListOptions` now.
    const listed: sdk.CustomerListFilters | undefined = undefined;
    // @ts-expect-error — `AccountSettings` is `AccountOptions` now.
    const settings: sdk.AccountSettings | undefined = undefined;
    // @ts-expect-error — `EntryFilters` is `EntryListOptions` now.
    const entryFilters: sdk.EntryFilters | undefined = undefined;
    // @ts-expect-error — `PriceFilters` is `PriceListOptions` now.
    const priceFilters: sdk.PriceFilters | undefined = undefined;

    expect([list.limit, account.allowNegative, entries.entryType, prices.operationCode, verify.secret]).toEqual([
      10,
      true,
      'charge',
      'support.reply',
      'whsec_x',
    ]);
    expect([listed, settings, entryFilters, priceFilters]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('reads the status of a run with the four predicates the PHP SDK has as methods', () => {
    const statuses = ['queued', 'waiting', 'running', 'completed', 'rejected', 'failed', 'uncertain'] as const;
    const read = (predicate: (run: { status: (typeof statuses)[number] }) => boolean): string[] =>
      statuses.filter((status) => predicate({ status }));

    expect(read(sdk.isPending)).toEqual(['queued', 'waiting', 'running']);
    expect(read(sdk.isFinished)).toEqual(['completed', 'rejected', 'failed', 'uncertain']);
    expect(read(sdk.isCompleted)).toEqual(['completed']);
    expect(read(sdk.isRejected)).toEqual(['rejected']);
  });
});
