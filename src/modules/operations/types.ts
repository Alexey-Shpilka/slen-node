import type { Id } from '../../wire.js';
import type { ExecutionCache, ExecutionCost, ExecutionStatus, WaitingOn } from '../executions/types.js';

/** The answer of `POST /v1/operations/execute`: the status view of the run, its `error` and whether it was `replayed`. */
export interface ExecutionResult {
  execution_id: Id;
  status: ExecutionStatus;
  operation: string;
  /** What the flow returned; null until it has returned something. */
  output: Record<string, unknown> | null;
  /** `error_code` and `error_message` as one object, whenever the run has a message; null otherwise. */
  error: { code: string; message: string } | null;
  /** Why the run did not complete; null for a completed or unfinished run. */
  error_code: string | null;
  /** The sentence that goes with `error_code`, to show or log, not to branch on. */
  error_message: string | null;
  /** `actual` is null in the answer of a run that has just finished: the charges arrive later. */
  cost: ExecutionCost;
  cache: ExecutionCache;
  /** True when the key belonged to a run that already existed: nothing ran, this is that run as it is now. */
  replayed: boolean;
  waiting_on: WaitingOn | null;
  trace_url: string;
  /** How long the server asks to wait before reading the run again. */
  retry_after_seconds?: number;
}
