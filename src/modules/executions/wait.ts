import { ConnectionError, SlenError, TimeoutError } from '../../errors.js';
import type { ExecutionStatus } from './types.js';

/** Told of a read that failed and will be repeated, with how many failed in a row; what it throws ends the wait. */
export type PollErrorListener = (error: SlenError, failuresInARow: number) => void | Promise<void>;

export interface WaitOptions {
  /** Default 300, at least 1. `Infinity` sets no ceiling; ten failed reads in a row then end the wait. */
  timeoutSeconds?: number;
  onPollError?: PollErrorListener;
  /** Ends the wait when aborted, during a read or a pause; the wait rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** @internal */
export const DEFAULT_WAIT_SECONDS = 300;

/** @internal */
export const MAX_FAILURES_WITHOUT_TIMEOUT = 10;

/** @internal */
export const SHORTEST_READ_MS = 5_000;

// A wait never reads faster than four times a second; a sliver of time left is no time.
const SHORTEST_PAUSE_MS = 250;
const NEGLIGIBLE_MS = 5;
const LONGEST_PAUSE_SECONDS = 30;

// `setTimeout` keeps its delay in a signed 32-bit integer and fires at once beyond it.
const LONGEST_TIMER_MS = 2_147_483_647;

/** Still going to move on its own. */
export function isPending(run: { readonly status: ExecutionStatus }): boolean {
  return run.status === 'queued' || run.status === 'waiting' || run.status === 'running';
}

/** Over: it will not move any more, whatever it came to. */
export function isFinished(run: { readonly status: ExecutionStatus }): boolean {
  return isPending(run) === false;
}

/** Over: the flow ran to its end. */
export function isCompleted(run: { readonly status: ExecutionStatus }): boolean {
  return run.status === 'completed';
}

/** The flow said no, as an answer: `error_code` says why. A refusal thrown as an error is the other form. */
export function isRejected(run: { readonly status: ExecutionStatus }): boolean {
  return run.status === 'rejected';
}

/** @internal */
export function waitMs(seconds: number | undefined): number {
  const given = Number(seconds ?? DEFAULT_WAIT_SECONDS);

  return Math.max(1, Number.isNaN(given) ? DEFAULT_WAIT_SECONDS : given) * 1_000;
}

/** @internal */
export function readTimeoutMs(clientMs: number, deadline: number, now: number): number {
  const remaining = deadline - now;
  const left = remaining >= SHORTEST_READ_MS ? remaining : SHORTEST_READ_MS;

  return clientMs <= left ? clientMs : left;
}

/** @internal */
export function nextDelayMs(retryAfterSeconds: number | undefined, step: number, random: () => number): number {
  const asked = Number(retryAfterSeconds ?? Number.NaN);
  const seconds = Number.isFinite(asked) ? asked : Math.min(LONGEST_PAUSE_SECONDS, 2 ** Math.min(5, Math.max(0, step - 1)));
  const jitter = seconds * (random() * 0.5 - 0.25);

  return Math.max(SHORTEST_PAUSE_MS, Math.round((seconds + jitter) * 1_000));
}

/** @internal */
export function pauseBefore(deadline: number, now: number, wantedMs: number): number | null {
  const remaining = deadline - now;

  // Negated on purpose: a value that is not a number reads as "up", never as "poll at once".
  if (!(remaining >= NEGLIGIBLE_MS)) {
    return null;
  }

  const pause = wantedMs >= SHORTEST_PAUSE_MS ? wantedMs : SHORTEST_PAUSE_MS;

  return Math.min(pause, remaining, LONGEST_TIMER_MS);
}

/** @internal */
export function isPassing(error: unknown): error is SlenError {
  if (!(error instanceof SlenError)) {
    return false;
  }

  if (error instanceof TimeoutError || error instanceof ConnectionError) {
    return true;
  }

  return error.status === 429 || (error.status !== null && error.status >= 500);
}
