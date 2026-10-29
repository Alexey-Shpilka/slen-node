import { PolicyDeniedError, SlenError, SpendRefusedError } from '../errors.js';
import type { SpanRecorder } from './recorder.js';
import type { SlenSpan, SpanOperation, SpanOutcome } from './span.js';

/** @internal */
export interface SpannedRun {
  readonly execution_id: string;
  readonly operation: string;
  readonly status: string;
  readonly error_code: string | null;
  readonly error?: { readonly code: string } | null;
  readonly cost: { readonly estimated: string | null; readonly actual: string | null };
  readonly cache: { readonly hit: boolean };
}

/** @internal */
export interface SpanSubject {
  readonly operation: SpanOperation;
  readonly operationCode?: string | null;
  readonly executionId?: string | null;
}

// A run that has no answer yet: the server says `cache.hit: false` for it, which is not a miss.
const PENDING = new Set(['queued', 'waiting', 'running']);

/** @internal */
export class SpanScope {
  readonly #recorder: SpanRecorder;
  readonly #operation: SpanOperation;
  readonly #operationCode: string | null;
  readonly #executionId: string | null;
  readonly #now: () => number;
  readonly #startedAt: number;

  constructor(recorder: SpanRecorder, subject: SpanSubject, now: () => number = Date.now) {
    this.#recorder = recorder;
    this.#operation = subject.operation;
    this.#operationCode = subject.operationCode ?? null;
    this.#executionId = subject.executionId ?? null;
    this.#now = now;
    this.#startedAt = now();
  }

  execution(run: SpannedRun): void {
    this.#emit({
      outcome: outcomeOf(run.status),
      status: run.status,
      executionId: run.execution_id,
      operationCode: run.operation,
      estimated: run.cost.estimated,
      actual: run.cost.actual,
      errorCode: run.error_code ?? run.error?.code ?? null,
      cacheHit: PENDING.has(run.status) ? null : run.cache.hit === true,
    });
  }

  failed(error: unknown, operationCode: string | null = this.#operationCode): void {
    this.#emit({
      outcome: error instanceof SpendRefusedError || error instanceof PolicyDeniedError ? 'refused' : 'error',
      operationCode,
      errorCode: error instanceof SlenError ? error.code : null,
    });
  }

  #emit(fields: Partial<Omit<SlenSpan, 'operation' | 'durationMs'>>): void {
    const span: SlenSpan = {
      operation: this.#operation,
      outcome: fields.outcome ?? 'ok',
      status: fields.status ?? null,
      durationMs: Math.max(0, this.#now() - this.#startedAt),
      executionId: fields.executionId ?? this.#executionId,
      operationCode: fields.operationCode ?? this.#operationCode,
      estimated: fields.estimated ?? null,
      actual: fields.actual ?? null,
      errorCode: fields.errorCode ?? null,
      cacheHit: fields.cacheHit ?? null,
    };

    try {
      this.#recorder.record(span);
    } catch {
      // Telemetry may not break the call it describes.
    }
  }
}

function outcomeOf(status: string): SpanOutcome {
  if (status === 'rejected') {
    return 'refused';
  }

  return status === 'failed' || status === 'uncertain' ? 'error' : 'ok';
}
