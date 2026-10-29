import type { SlenError } from '../errors.js';
import { LOG_EVENTS, type SlenLogger, writeLog } from '../logger.js';
import type { ApiRequest, HttpAnswer } from './client.js';

/** @internal */
export type RetryReason = 'no_answer' | 'rate_limited' | 'unavailable';

/** @internal */
export interface RetryPause {
  readonly delayMs: number;
  readonly reason: RetryReason;
  readonly status: number | null;
}

// A 403 under these codes is a key that cannot do this: a setting to fix, not a refusal.
const KEY_CODES = new Set(['insufficient_scope', 'invalid_api_key', 'not_a_member']);

/** @internal */
export class HttpJournal {
  readonly #logger: SlenLogger;

  constructor(logger: SlenLogger) {
    this.#logger = logger;
  }

  request(request: ApiRequest, attempt: number): void {
    writeLog(this.#logger, LOG_EVENTS.request, { ...where(request), attempt });
  }

  response(request: ApiRequest, answer: HttpAnswer, durationMs: number): void {
    writeLog(this.#logger, LOG_EVENTS.response, {
      ...where(request),
      status: answer.status,
      duration_ms: durationMs,
      request_id: answer.requestId,
    });
  }

  retry(request: ApiRequest, attempt: number, pause: RetryPause): void {
    writeLog(this.#logger, LOG_EVENTS.retry, {
      ...where(request),
      attempt,
      delay_ms: pause.delayMs,
      reason: pause.reason,
      status: pause.status,
    });
  }

  rejected(request: ApiRequest, error: SlenError, attempts: number): void {
    const fields = { ...where(request), status: error.status, error_code: error.code };
    const status = error.status ?? 0;

    if (status === 401 || (status === 403 && (error.code === null || KEY_CODES.has(error.code)))) {
      writeLog(this.#logger, LOG_EVENTS.unauthorized, { ...fields, request_id: error.requestId });

      return;
    }

    if (status >= 400 && status < 500) {
      writeLog(this.#logger, LOG_EVENTS.refused, { ...fields, request_id: error.requestId });

      return;
    }

    writeLog(this.#logger, LOG_EVENTS.failed, {
      ...fields,
      error_type: contractTypeOf(error),
      request_id: error.requestId,
      attempts,
    });
  }
}

function where(request: ApiRequest): { method: string; route: string } {
  return { method: request.method, route: request.route };
}

/** @internal */
export function contractTypeOf(error: SlenError): string {
  return error.name.replace(/Error$/, '');
}
