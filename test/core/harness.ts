import { resolveConfig, type SlenOptions } from '../../src/config.js';
import { ApiClient, FetchClient } from '../../src/http/client.js';
import { HttpJournal } from '../../src/http/logging.js';
import { RetryClient } from '../../src/http/retry.js';
import type { SlenLogger } from '../../src/logger.js';
import { FakeFetch } from '../../src/testing/index.js';

export interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: string;
  readonly context: Record<string, unknown>;
}

/** A logger that keeps what it is given, in order. */
export function recordingLogger(): { logger: SlenLogger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const keep =
    (level: LogRecord['level']) =>
    (event: string, context: Record<string, unknown> = {}): void => {
      records.push({ level, event, context });
    };

  return { logger: { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') }, records };
}

export interface Chain {
  readonly api: ApiClient;
  readonly http: FakeFetch;
  readonly records: LogRecord[];
  /** The pauses the retry asked for, in ms; none of them is waited out. */
  readonly pauses: number[];
}

/** The chain `Slen` builds — core, retry, journal — on a `FakeFetch`, with pauses that cost no time. */
export function chain(options: SlenOptions = {}): Chain {
  const http = new FakeFetch();
  const { logger, records } = recordingLogger();
  const config = resolveConfig({ apiKey: 'sl_live_core', baseUrl: 'https://sdk.example', fetch: http.fetch, logger, ...options });
  const journal = new HttpJournal(config.logger);
  const pauses: number[] = [];
  const pause = async (ms: number, signal: AbortSignal | undefined): Promise<void> => {
    pauses.push(ms);

    if (signal?.aborted === true) {
      throw signal.reason;
    }
  };

  return {
    api: new ApiClient(new RetryClient(new FetchClient(config), journal, { retries: config.retries, pause, random: () => 0.5 }), journal),
    http,
    records,
    pauses,
  };
}

/** The settled outcome of a promise, for asserting on a rejection's type and fields. */
export async function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => ({ resolved: value }),
    (error: unknown) => error,
  );
}
