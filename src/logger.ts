/** Where the SDK writes its journal, an event of `LOG_EVENTS` and its fields: `console`, or any logger with these four methods. */
export interface SlenLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** The default logger: the journal goes nowhere. */
export const NOOP_LOGGER: SlenLogger = Object.freeze({
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
});

/** The events of the journal; the PHP SDK writes the same names with the same fields. */
export const LOG_EVENTS = Object.freeze({
  request: 'slen.request',
  response: 'slen.response',
  retry: 'slen.retry',
  refused: 'slen.refused',
  unauthorized: 'slen.unauthorized',
  failed: 'slen.failed',
  waitPoll: 'slen.wait.poll',
  waitPollFailed: 'slen.wait.poll_failed',
  webhookRejected: 'slen.webhook.rejected',
} as const);

export type LogEvent = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Readonly<Record<LogEvent, LogLevel>> = {
  [LOG_EVENTS.request]: 'debug',
  [LOG_EVENTS.response]: 'debug',
  [LOG_EVENTS.retry]: 'warn',
  [LOG_EVENTS.refused]: 'info',
  [LOG_EVENTS.unauthorized]: 'error',
  [LOG_EVENTS.failed]: 'error',
  [LOG_EVENTS.waitPoll]: 'debug',
  [LOG_EVENTS.waitPollFailed]: 'warn',
  [LOG_EVENTS.webhookRejected]: 'warn',
};

/** @internal */
export function writeLog(logger: SlenLogger, event: LogEvent, context: Record<string, unknown>): void {
  try {
    logger[LEVELS[event]](event, context);
  } catch {
    // The journal is telemetry.
  }
}
