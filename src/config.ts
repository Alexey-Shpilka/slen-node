import { NOOP_LOGGER, type SlenLogger } from './logger.js';
import type { OtlpExporterOptions } from './observability/otlp.js';
import type { SpanRecorder } from './observability/recorder.js';

/** The hosted API. Another address is for tests and a local stack only. */
export const DEFAULT_BASE_URL = 'https://api.slen.ai';

// Above the minute the API gives one provider attempt.
const DEFAULT_TIMEOUT_MS = 65_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface SlenOptions {
  /** The project's API key. Falls back to `SLEN_API_KEY`. */
  apiKey?: string;
  /** Host root without `/api`, for tests and a local stack. Default: the hosted API. */
  baseUrl?: string;
  /** How long one attempt may take, in ms. Default 65 000. */
  timeoutMs?: number;
  /** Attempts after the first when there is no answer, a 429 or a 503. Default 2. */
  retries?: number;
  /** Where the journal goes: `console` or any logger with `debug`, `info`, `warn`, `error`. Default: nowhere. */
  logger?: SlenLogger;
  /** Where spans go. Default: nowhere. */
  spanRecorder?: SpanRecorder;
  /** Sends spans to an OTLP/HTTP collector, next to `spanRecorder`. */
  otlp?: OtlpExporterOptions;
  /** The `fetch` requests are sent with. Default: the runtime's own. */
  fetch?: typeof fetch;
  /** Extra headers on every request. The SDK's own headers win over them. */
  headers?: Record<string, string>;
  /** The signing secret of your webhook endpoint, for verifying `Slen-Signature`. */
  webhookSecret?: string;
  /** How old a webhook signature may be, in seconds. Default 300. */
  webhookToleranceSeconds?: number;
}

/** The options with every default applied: what the HTTP chain is built from. */
export interface SlenConfig {
  readonly apiKey: string;
  /** Without a trailing slash and without `/api`. */
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly logger: SlenLogger;
  readonly fetch: typeof fetch;
  readonly webhookSecret: string | null;
  readonly webhookToleranceSeconds: number;
}

/** Applies the defaults and checks the values; touches no network. @throws TypeError @throws RangeError */
export function resolveConfig(options: SlenOptions): SlenConfig {
  const apiKey = options.apiKey ?? fromEnv('SLEN_API_KEY');

  if (apiKey === undefined || apiKey.trim() === '') {
    throw new TypeError('Slen: an apiKey is required (pass `apiKey` or set SLEN_API_KEY).');
  }

  return Object.freeze({
    apiKey,
    baseUrl: hostRoot(options.baseUrl ?? DEFAULT_BASE_URL),
    timeoutMs: positive('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    retries: whole('retries', options.retries ?? DEFAULT_RETRIES, 0),
    headers: Object.freeze({ ...(options.headers ?? {}) }),
    logger: options.logger ?? NOOP_LOGGER,
    fetch: fetchOf(options.fetch ?? globalThis.fetch),
    webhookSecret: secretOf(options.webhookSecret ?? null),
    webhookToleranceSeconds: whole('webhookToleranceSeconds', options.webhookToleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS, 1),
  });
}

/** Where the API is mounted: every route of the spec follows it. */
export function apiBase(config: Pick<SlenConfig, 'baseUrl'>): string {
  return `${config.baseUrl}/api`;
}

// `process` is absent in a browser or a worker; nothing is read there.
function fromEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

  return env?.[name];
}

function hostRoot(value: string): string {
  return value.replace(/\/+$/, '');
}

function positive(name: string, value: number): number {
  if (!(value > 0)) {
    throw new RangeError(`Slen: ${name} must be a number above 0, got ${String(value)}.`);
  }

  return value;
}

function whole(name: string, value: number, least: number): number {
  if (!Number.isInteger(value) || value < least) {
    throw new RangeError(`Slen: ${name} must be an integer of at least ${least}, got ${String(value)}.`);
  }

  return value;
}

// An empty or blank secret is a variable that was not set, not a secret.
function secretOf(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}

function fetchOf(value: typeof fetch | undefined): typeof fetch {
  if (typeof value !== 'function') {
    throw new TypeError('Slen: this runtime has no fetch; pass one as the `fetch` option.');
  }

  return value;
}
