import { resolveConfig, type SlenOptions } from '../../src/config.js';
import { ApiClient, FetchClient } from '../../src/http/client.js';
import { HttpJournal } from '../../src/http/logging.js';
import { RetryClient } from '../../src/http/retry.js';
import type { Clock, ModuleContext } from '../../src/modules/context.js';
import { CustomersModule } from '../../src/modules/customers/customers.js';
import type { CreditEntry, CreditPrice, Customer, CustomerAccount } from '../../src/modules/customers/types.js';
import { ExecutionsModule } from '../../src/modules/executions/executions.js';
import type { ExecutionStatusView } from '../../src/modules/executions/types.js';
import { OperationsModule } from '../../src/modules/operations/operations.js';
import type { ExecutionResult } from '../../src/modules/operations/types.js';
import { MemorySpanRecorder } from '../../src/observability/recorder.js';
import { FakeFetch } from '../../src/testing/index.js';
import { type LogRecord, recordingLogger } from '../core/harness.js';

export const SECRET_PROMPT = 'my secret system prompt: the launch is on the 14th';

/** A clock that moves only when the code under test sleeps; every pause is kept. */
export interface FakeClock extends Clock {
  readonly pauses: number[];
  advance(ms: number): void;
}

export function fakeClock(start = 1_800_000_000_000): FakeClock {
  let now = start;
  const pauses: number[] = [];

  return {
    pauses,
    now: () => now,
    random: () => 0.5,
    advance: (ms: number): void => {
      now += ms;
    },
    async sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
      if (signal?.aborted === true) {
        throw signal.reason;
      }

      pauses.push(ms);
      now += ms;
      await Promise.resolve();
    },
  };
}

export interface Modules {
  readonly operations: OperationsModule;
  readonly executions: ExecutionsModule;
  readonly customers: CustomersModule;
  readonly http: FakeFetch;
  readonly spans: MemorySpanRecorder;
  readonly records: LogRecord[];
  readonly clock: FakeClock;
  /** The pauses of the HTTP retry, in ms; none of them is waited out. */
  readonly retryPauses: number[];
}

/** The modules as `Slen` builds them, on a `FakeFetch`, a fake clock and pauses of the retry that cost no time. */
export function modules(options: SlenOptions = {}): Modules {
  const http = new FakeFetch();
  const spans = new MemorySpanRecorder();
  const { logger, records } = recordingLogger();
  const config = resolveConfig({ apiKey: 'sl_live_modules', baseUrl: 'https://sdk.example', fetch: http.fetch, logger, ...options });
  const journal = new HttpJournal(config.logger);
  const retryPauses: number[] = [];
  const pause = async (ms: number): Promise<void> => {
    retryPauses.push(ms);
  };
  const api = new ApiClient(new RetryClient(new FetchClient(config), journal, { retries: config.retries, pause, random: () => 0.5 }), journal);
  const context: ModuleContext = { api, config, spans };
  const clock = fakeClock();

  return {
    operations: new OperationsModule(context),
    executions: new ExecutionsModule(context, clock),
    customers: new CustomersModule(context),
    http,
    spans,
    records,
    clock,
    retryPauses,
  };
}

export function execution(fields: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    execution_id: '74438200973594700',
    status: 'completed',
    operation: 'support.reply',
    output: { content: 'Your order ships tomorrow.' },
    error: null,
    error_code: null,
    error_message: null,
    cost: { estimated: '0.00412500', actual: null },
    cache: { hit: false, cached_at: null },
    replayed: false,
    waiting_on: null,
    trace_url: '/v1/executions/74438200973594700',
    ...fields,
  };
}

export function statusView(fields: Partial<ExecutionStatusView> = {}): ExecutionStatusView {
  return {
    execution_id: '74438200973594700',
    status: 'completed',
    operation: 'support.reply',
    output: { content: 'Your order ships tomorrow.' },
    error_code: null,
    error_message: null,
    cost: { estimated: '0.00412500', actual: '0.00398000' },
    cache: { hit: false, cached_at: null },
    waiting_on: null,
    trace_url: '/v1/executions/74438200973594700',
    ...fields,
  };
}

export function queued(fields: Partial<ExecutionStatusView> = {}): ExecutionStatusView {
  return statusView({
    status: 'queued',
    output: null,
    cost: { estimated: null, actual: null },
    waiting_on: { node_key: 'start', type: 'async_dispatch', resume_at: null },
    retry_after_seconds: 2,
    ...fields,
  });
}

export function account(fields: Partial<CustomerAccount> = {}): CustomerAccount {
  return {
    customer_account_id: '74438200973594624',
    customer_id: '74438200973594624',
    project_id: '74438200973500001',
    external_user_id: 'user_8421',
    credit_type: 'default',
    balance: '95.0000',
    reserved: '0.0000',
    available: '95.0000',
    allow_negative: false,
    low_balance_threshold: '10.0000',
    created_at: '2026-10-17T10:00:00+00:00',
    updated_at: '2026-10-17T10:05:00+00:00',
    ...fields,
  };
}

export function customer(fields: Partial<Customer> = {}): Customer {
  return {
    customer_id: '74438200973594624',
    external_user_id: 'user_8421',
    status: 'active',
    blocked_at: null,
    block_reason: null,
    accounts: [account()],
    created_at: '2026-10-17T10:00:00+00:00',
    updated_at: '2026-10-17T10:05:00+00:00',
    ...fields,
  };
}

export function entry(fields: Partial<CreditEntry> = {}): CreditEntry {
  return {
    entry_id: '74438200973594800',
    customer_account_id: '74438200973594624',
    external_user_id: 'user_8421',
    credit_type: 'default',
    entry_type: 'charge',
    credits: '-5.0000',
    balance_after: '90.0000',
    available_after: '90.0000',
    reservation_id: null,
    note: 'PDF export',
    created_at: '2026-10-17T10:06:00+00:00',
    ...fields,
  };
}

export function price(fields: Partial<CreditPrice> = {}): CreditPrice {
  return {
    credit_price_id: '74438200973594900',
    project_id: '74438200973500001',
    operation_code: 'support.reply',
    credit_type: 'default',
    credits: '1.0000',
    created_at: '2026-10-17T09:00:00+00:00',
    updated_at: '2026-10-17T09:00:00+00:00',
    ...fields,
  };
}
