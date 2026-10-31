import { type ApiRequest, type RequestOptions, refuseBeforeTheWire, transportOf } from '../../http/client.js';
import { type Endpoint, endpoint, ENDPOINTS } from '../../http/endpoints.js';
import { contractTypeOf } from '../../http/logging.js';
import { LOG_EVENTS, writeLog } from '../../logger.js';
import { SpanScope } from '../../observability/scope.js';
import type { WithRequestId } from '../../wire.js';
import { type Clock, type ModuleContext, SYSTEM_CLOCK } from '../context.js';
import type { ExecutionStatusView, ExecutionTrace } from './types.js';
import {
  isPassing,
  isPending,
  MAX_FAILURES_WITHOUT_TIMEOUT,
  nextDelayMs,
  pauseBefore,
  readTimeoutMs,
  waitMs,
  type WaitOptions,
} from './wait.js';

/** Reads a run: its status, a wait until it is over, its trace. */
export class ExecutionsModule {
  readonly #context: ModuleContext;
  readonly #clock: Clock;

  /** @internal */
  constructor(context: ModuleContext, clock: Clock = SYSTEM_CLOCK) {
    this.#context = context;
    this.#clock = clock;
  }

  /** The polling view of one run, read once. Writes no span. @throws SlenError */
  get(executionId: string, options: RequestOptions = {}): Promise<WithRequestId<ExecutionStatusView>> {
    return this.#context.api.request<ExecutionStatusView>(read(ENDPOINTS.executionStatus, executionId, options));
  }

  /** Reads the run until it is over, at the pace the server asks; at the timeout, answers the last state read. @throws SlenError */
  async wait(executionId: string, options: WaitOptions = {}): Promise<WithRequestId<ExecutionStatusView>> {
    refuseBeforeTheWire(read(ENDPOINTS.executionStatus, executionId, options));

    const span = new SpanScope(this.#context.spans, { operation: 'executions.wait', executionId }, () => this.#clock.now());
    const progress: Progress = { seen: null };

    try {
      const run = await this.#poll(executionId, options, progress);
      span.execution(run);

      return run;
    } catch (error) {
      span.failed(error, progress.seen?.operation ?? null);

      throw error;
    }
  }

  /** The trace of one run: every node, event and provider attempt. @throws SlenError */
  trace(executionId: string, options: RequestOptions = {}): Promise<WithRequestId<ExecutionTrace>> {
    return this.#context.api.request<ExecutionTrace>(read(ENDPOINTS.executionTrace, executionId, options));
  }

  async #poll(executionId: string, options: WaitOptions, progress: Progress): Promise<WithRequestId<ExecutionStatusView>> {
    const { config } = this.#context;
    const deadline = this.#clock.now() + waitMs(options.timeoutSeconds);
    let failure: unknown = null;
    let answers = 0;
    let failures = 0;

    for (;;) {
      if (aborted(options.signal)) {
        throw options.signal?.reason;
      }

      let answered: WithRequestId<ExecutionStatusView> | null = null;

      try {
        answered = await this.#context.api.request<ExecutionStatusView>({
          ...read(ENDPOINTS.executionStatus, executionId, options),
          timeoutMs: readTimeoutMs(config.timeoutMs, deadline, this.#clock.now()),
          retries: 0,
        });
        progress.seen = answered;
        failures = 0;
      } catch (error) {
        if (aborted(options.signal) || !isPassing(error)) {
          throw error;
        }

        failure = error;
        failures += 1;
        writeLog(config.logger, LOG_EVENTS.waitPollFailed, {
          execution_id: executionId,
          failures_in_a_row: failures,
          error_type: contractTypeOf(error),
        });

        // Outside the read's `try`: what the listener throws is the caller's own and ends the wait.
        await options.onPollError?.(error, failures);

        if (deadline === Number.POSITIVE_INFINITY && failures >= MAX_FAILURES_WITHOUT_TIMEOUT) {
          throw error;
        }
      }

      const over = answered !== null && !isPending(answered);
      const step = answered === null ? failures : (answers += 1);
      const pause = over ? null : pauseBefore(deadline, this.#clock.now(), nextDelayMs(answered?.retry_after_seconds, step, () => this.#clock.random()));

      if (answered !== null) {
        writeLog(config.logger, LOG_EVENTS.waitPoll, { execution_id: executionId, status: answered.status, next_poll_ms: pause });
      }

      if (over) {
        return answered as WithRequestId<ExecutionStatusView>;
      }

      if (pause === null) {
        break;
      }

      await this.#clock.sleep(pause, options.signal);
    }

    if (progress.seen === null) {
      throw failure;
    }

    return progress.seen;
  }
}

// A function, so that the check after an `await` is not narrowed away by the one before it.
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface Progress {
  seen: WithRequestId<ExecutionStatusView> | null;
}

function read(operation: Endpoint, executionId: string, options: RequestOptions): ApiRequest {
  return { ...endpoint(operation), params: { id: executionId }, ...transportOf(options) };
}
