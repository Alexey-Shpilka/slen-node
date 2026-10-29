import type { SlenConfig } from '../config.js';
import type { ApiClient } from '../http/client.js';
import type { SpanRecorder } from '../observability/recorder.js';

/** @internal */
export interface ModuleContext {
  readonly api: ApiClient;
  readonly config: SlenConfig;
  readonly spans: SpanRecorder;
}

/** @internal */
export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal | undefined): Promise<void>;
  random(): number;
}

/** @internal */
export const SYSTEM_CLOCK: Clock = Object.freeze({
  now: (): number => Date.now(),
  sleep,
  random: (): number => Math.random(),
});

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
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
