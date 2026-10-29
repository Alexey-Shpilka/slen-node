import { ConnectionError, type SlenError, TimeoutError } from '../errors.js';
import type { ApiRequest, HttpAnswer, HttpClient } from './client.js';
import type { HttpJournal, RetryPause } from './logging.js';

/** @internal */
export const RETRY_AFTER_CEILING_MS = 30_000;

const BACKOFF_BASE_MS = 200;
const BACKOFF_CEILING_MS = 5_000;

/** @internal */
export type Pause = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

/** @internal */
export interface RetryPolicy {
  readonly retries: number;
  readonly pause?: Pause;
  readonly random?: () => number;
}

/** @internal */
export class RetryClient implements HttpClient {
  readonly #inner: HttpClient;
  readonly #retries: number;
  readonly #journal: HttpJournal;
  readonly #pause: Pause;
  readonly #random: () => number;

  constructor(inner: HttpClient, journal: HttpJournal, policy: RetryPolicy) {
    this.#inner = inner;
    this.#journal = journal;
    this.#retries = policy.retries;
    this.#pause = policy.pause ?? pauseFor;
    this.#random = policy.random ?? Math.random;
  }

  async send(request: ApiRequest): Promise<HttpAnswer> {
    const retries = request.retries ?? this.#retries;
    let afterNoAnswer = false;

    for (let attempt = 1; ; attempt += 1) {
      this.#journal.request(request, attempt);

      let answer: HttpAnswer;

      try {
        answer = await this.#inner.send(request);
      } catch (error) {
        if (request.signal?.aborted === true || !isNoAnswer(error)) {
          throw error;
        }

        if (attempt > retries) {
          this.#journal.rejected(request, error, attempt);

          throw error;
        }

        await this.#wait(request, attempt, { delayMs: backoffMs(attempt - 1, this.#random), reason: 'no_answer', status: null });
        afterNoAnswer = true;
        continue;
      }

      const delayMs = attempt > retries ? null : retryDelayMs(answer, attempt - 1, this.#random);

      if (delayMs === null) {
        return { ...answer, attempts: attempt, afterNoAnswer };
      }

      await this.#wait(request, attempt, { delayMs, reason: answer.status === 429 ? 'rate_limited' : 'unavailable', status: answer.status });
    }
  }

  async #wait(request: ApiRequest, attempt: number, pause: RetryPause): Promise<void> {
    this.#journal.retry(request, attempt, pause);
    await this.#pause(pause.delayMs, request.signal);
  }
}

// What the core throws when the answer did not arrive; a server's own timeout comes with a code.
function isNoAnswer(error: unknown): error is SlenError {
  return (error instanceof TimeoutError || error instanceof ConnectionError) && error.code === null;
}

/** @internal */
export function retryDelayMs(answer: Pick<HttpAnswer, 'status' | 'headers'>, retried: number, random: () => number): number | null {
  if (answer.status !== 429 && answer.status !== 503) {
    return null;
  }

  const asked = retryAfterMs(answer.headers.get('retry-after'));

  if (asked === null) {
    return backoffMs(retried, random);
  }

  return asked <= RETRY_AFTER_CEILING_MS ? asked : null;
}

/** @internal */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') {
    return null;
  }

  if (/^\d+$/.test(value.trim())) {
    return Number(value.trim()) * 1000;
  }

  const date = Date.parse(value);

  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** @internal */
export function backoffMs(retried: number, random: () => number = Math.random): number {
  const base = BACKOFF_BASE_MS * 2 ** Math.min(Math.max(retried, 0), 16);

  return Math.min(Math.round(base * (0.75 + random() * 0.5)), BACKOFF_CEILING_MS);
}

function pauseFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);

      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
