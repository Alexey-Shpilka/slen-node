import type { Id, Money } from '../../wire.js';

export type ExecutionStatus = 'running' | 'queued' | 'waiting' | 'completed' | 'rejected' | 'failed' | 'uncertain';

/** What a `waiting` or `queued` run waits on; `provider_background` is a provider call running as a background job. */
export type ParkReason = 'queue_node' | 'approval' | 'rate_limit_queue' | 'async_dispatch' | 'provider_background';

export interface WaitingOn {
  node_key: string;
  type: ParkReason;
  resume_at: string | null;
}

/** Whether `output` is a stored answer of an earlier model call, whose `usage` this run did not pay; true only for a completed run. */
export interface ExecutionCache {
  hit: boolean;
  /** When the served answer was stored. Null unless `hit`. */
  cached_at: string | null;
}

/** `estimated` when the model call was authorized; `actual` arrives later, when the run's charges are in. */
export interface ExecutionCost {
  estimated: Money | null;
  actual: Money | null;
}

/** `GET /v1/executions/{id}/status`: the polling view of a run. Why it did not complete is `error_code`. */
export interface ExecutionStatusView {
  execution_id: Id;
  status: ExecutionStatus;
  operation: string;
  /** What the flow returned; null until it has returned something. */
  output: Record<string, unknown> | null;
  error_code: string | null;
  /** The sentence that goes with `error_code`, to show or log, not to branch on. */
  error_message: string | null;
  cost: ExecutionCost;
  cache: ExecutionCache;
  waiting_on: WaitingOn | null;
  trace_url: string;
  /** How long the server asks to wait before the next read; only while the run is still going to move. */
  retry_after_seconds?: number;
}

/** A node is written to the trace once, when it has finished. */
export type NodeExecutionStatus = 'completed' | 'failed';

/** One provider attempt a node opened. */
export interface AttemptSummary {
  attempt_id: Id;
  attempt_number: number;
  connection_id: Id;
  pool_id?: Id | null;
  status: string;
  error_code?: string | null;
  latency_ms?: number | null;
  cost?: Money | null;
  provider_request_id?: string | null;
  /** The model the attempt put on the wire. */
  model_code?: string | null;
}

/** One node the run walked through. */
export interface FlowExecutionNode {
  node_key: string;
  /** The node type, left open: the backend adds types. */
  node_type: string;
  status: NodeExecutionStatus;
  /** Which edge the node left by; null for a node the flow ended at. */
  output_port?: string | null;
  cost?: Money | null;
  duration_ms?: number | null;
  started_at: string;
  finished_at?: string | null;
  metadata?: Record<string, unknown> | null;
  attempts: AttemptSummary[];
  label?: string | null;
  /** The model of the node's last provider attempt, or the one its budget was read for. */
  model?: string | null;
  /** The node's own decision or refusal; it can differ from the run's `error_code`. */
  code?: string | null;
}

/** One line of the run's timeline. */
export interface FlowExecutionEvent {
  /** Events of one node are ordered by this, not by the clock. */
  seq: number;
  /** The event, left open: the runtime adds and drops events. */
  type: string;
  node_key?: string | null;
  occurred_at: string;
  /** Amounts, ids and verdicts; never prompts or provider messages. */
  payload?: Record<string, unknown> | null;
}

/** `GET /v1/executions/{id}`: the stored run with every node and event. */
export interface ExecutionTrace {
  execution_id: Id;
  flow_id: Id;
  flow_version_id: Id;
  flow_name?: string | null;
  operation?: string | null;
  operation_id?: Id | null;
  status: ExecutionStatus;
  error_code?: string | null;
  error_message?: string | null;
  cost: ExecutionCost;
  cache: ExecutionCache;
  started_at: string;
  finished_at?: string | null;
  duration_ms?: number | null;
  nodes: FlowExecutionNode[];
  events: FlowExecutionEvent[];
}
