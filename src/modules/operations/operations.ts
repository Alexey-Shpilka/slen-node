import { INVALID_REQUEST, InvalidRequestError } from '../../errors.js';
import { type ApiRequest, type CallOptions, refuseBeforeTheWire, transportOf } from '../../http/client.js';
import { endpoint, ENDPOINTS } from '../../http/endpoints.js';
import { generateIdempotencyKey } from '../../idempotency.js';
import { SpanScope } from '../../observability/scope.js';
import type { ModuleContext } from '../context.js';
import type { ExecutionResult } from './types.js';

/** A scalar the flow reads as `context.<key>`. */
export type ContextValue = string | number | boolean | null;

export interface ExecuteOptions extends CallOptions {
  /** The end customer the run is made for, sent as `context.user_id`. */
  customer?: string;
  /** Which of the customer's credit accounts the run draws on, sent as `context.credit_type`. */
  creditType?: string;
  /** Up to 64 values the flow reads as `context.<key>`. */
  context?: Readonly<Record<string, ContextValue>>;
}

interface RunOrder {
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly queued: boolean;
}

const CLAIMS = { customer: 'user_id', creditType: 'credit_type' } as const;

/** Runs the flow bound to an operation; the caller names what it wants done, never a model. */
export class OperationsModule {
  readonly #context: ModuleContext;

  /** @internal */
  constructor(context: ModuleContext) {
    this.#context = context;
  }

  /** Runs the flow inside the request and answers with the run; a repeated key answers the first run. @throws SlenError */
  execute(operation: string, input: Record<string, unknown>, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    return this.#run({ operation, input, queued: false }, options);
  }

  /** Hands the run to a worker and answers `queued` at once; `executions.wait()` or a webhook tells the rest. @throws SlenError */
  executeAsync(operation: string, input: Record<string, unknown>, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    return this.#run({ operation, input, queued: true }, options);
  }

  async #run(order: RunOrder, options: ExecuteOptions): Promise<ExecutionResult> {
    const request: ApiRequest = {
      ...endpoint(ENDPOINTS.execute),
      body: bodyOf(order, options),
      idempotencyKey: options.idempotencyKey ?? generateIdempotencyKey(),
      ...transportOf(options),
    };

    refuseBeforeTheWire(request);

    // Named by the call, not by the answer: a replayed key answers with the run as it is now.
    const span = new SpanScope(this.#context.spans, {
      operation: order.queued ? 'operations.execute_async' : 'operations.execute',
      operationCode: order.operation,
    });

    try {
      const run = await this.#context.api.request<ExecutionResult>(request);
      span.execution(run);

      return run;
    } catch (error) {
      span.failed(error);

      throw error;
    }
  }
}

function bodyOf(order: RunOrder, options: ExecuteOptions): Record<string, unknown> {
  const context: Record<string, ContextValue> = { ...options.context };

  claim(context, 'customer', options.customer);
  claim(context, 'creditType', options.creditType);

  return {
    operation: order.operation,
    input: order.input,
    ...(Object.keys(context).length === 0 && options.context === undefined ? {} : { context }),
    ...(order.queued ? { execution_mode: 'async' } : {}),
  };
}

function claim(context: Record<string, ContextValue>, option: keyof typeof CLAIMS, value: string | undefined): void {
  const key = CLAIMS[option];

  if (value === undefined) {
    return;
  }

  if (value.trim() === '') {
    throw new InvalidRequestError(`Slen: \`${option}\` of ${ENDPOINTS.execute} is empty; pass one that is not, or none.`, {
      code: INVALID_REQUEST,
    });
  }

  const written = context[key];

  if (written !== undefined && (written === null || String(written) !== value)) {
    throw new InvalidRequestError(`Slen: \`${option}\` and \`context.${key}\` name two different values; pass one of them.`, {
      code: INVALID_REQUEST,
    });
  }

  context[key] = value;
}
