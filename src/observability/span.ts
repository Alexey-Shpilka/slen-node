/** What a call came to, in one word: done, refused by the control plane, or broken. */
export type SpanOutcome = 'ok' | 'refused' | 'error';

/** One SDK call as an APM sees it: money, ids, a verdict and a duration, never a prompt or an output. */
export interface SlenSpan {
  /** The SDK call: one of `SPAN_OPERATIONS`. */
  readonly operation: string;
  readonly outcome: SpanOutcome;
  /** The status of the run the answer carries; null when the call threw. */
  readonly status: string | null;
  /** Wall clock around the call: every attempt, and for a wait every read and pause. */
  readonly durationMs: number;
  readonly executionId: string | null;
  /** The operation the run is for: known before an execute, read from the answer on a wait. */
  readonly operationCode: string | null;
  /** Decimal string. */
  readonly estimated: string | null;
  /** Decimal string; null until the run's charges are in. */
  readonly actual: string | null;
  readonly errorCode: string | null;
  /** Whether a finished run was answered from the cache; null for a run without an answer yet. */
  readonly cacheHit: boolean | null;
}

/** The fields in the order their attributes are written. Money, ids, verdicts, durations only. */
export const SPAN_FIELDS = [
  'operation',
  'outcome',
  'status',
  'durationMs',
  'executionId',
  'operationCode',
  'estimated',
  'actual',
  'errorCode',
  'cacheHit',
] as const;

export type SpanField = (typeof SPAN_FIELDS)[number];

type Assert<T extends true> = T;

// The list and the interface cannot drift apart: a field in one and not the other fails `tsc`.
export type SpanFieldsCoverTheInterface = Assert<Exclude<keyof SlenSpan, SpanField> extends never ? true : false>;
export type InterfaceCoversSpanFields = Assert<Exclude<SpanField, keyof SlenSpan> extends never ? true : false>;

/** The snake_case attribute of each field, as a log line or an OTLP attribute set has it. */
export const SPAN_ATTRIBUTE_NAMES: Readonly<Record<SpanField, string>> = Object.freeze({
  operation: 'operation',
  outcome: 'outcome',
  status: 'status',
  durationMs: 'duration_ms',
  executionId: 'execution_id',
  operationCode: 'operation_code',
  estimated: 'estimated',
  actual: 'actual',
  errorCode: 'error_code',
  cacheHit: 'cache_hit',
});

/** The names a span is written under; a call that is not here writes no span. */
export const SPAN_OPERATIONS = ['operations.execute', 'operations.execute_async', 'executions.wait'] as const;

export type SpanOperation = (typeof SPAN_OPERATIONS)[number];

/** A flat attribute set. `cache_hit` is the one boolean, and `false` is kept. */
export type SpanAttributes = Record<string, string | number | boolean>;

/** The span as snake_case attributes, without the fields that are null. */
export function spanAttributes(span: SlenSpan): SpanAttributes {
  const attributes: SpanAttributes = {};

  for (const field of SPAN_FIELDS) {
    const value = span[field];

    if (value !== null && value !== undefined) {
      attributes[SPAN_ATTRIBUTE_NAMES[field]] = value;
    }
  }

  return attributes;
}
