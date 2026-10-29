import type { ExecutionStatusView, ExecutionTrace } from '../src/modules/executions/types.js';
import type { ExecutionResult } from '../src/modules/operations/types.js';

/** A prompt that must never turn up in a span. Searched for verbatim in tests. */
export const SECRET_PROMPT = 'the launch code is hunter2 and the customer is ACME';

export function execution(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    execution_id: '74438200973594700',
    status: 'completed',
    operation: 'support.answer',
    output: { text: SECRET_PROMPT },
    error: null,
    error_code: null,
    error_message: null,
    cost: { estimated: '0.02700000', actual: '0.01100000' },
    cache: { hit: false, cached_at: null },
    replayed: false,
    waiting_on: null,
    trace_url: '/v1/executions/74438200973594700',
    ...overrides,
  };
}

/** `GET /v1/executions/{id}` — the keys `FlowExecutionTraceResource` sends, no others. */
export function trace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    execution_id: '74438200973594700',
    flow_id: '74438200973594001',
    flow_version_id: '74438200973594002',
    operation: 'support.answer',
    operation_id: '74438200973594625',
    status: 'completed',
    error_code: null,
    error_message: null,
    cost: { estimated: '0.02700000', actual: '0.01100000' },
    cache: { hit: false, cached_at: null },
    started_at: '2026-08-03T09:55:00+00:00',
    finished_at: '2026-08-03T09:55:02+00:00',
    duration_ms: 2140,
    nodes: [
      {
        node_key: 'model_1',
        node_type: 'ai_model',
        status: 'completed',
        output_port: 'success',
        cost: '0.01100000',
        duration_ms: 1980,
        started_at: '2026-08-03T09:55:00+00:00',
        finished_at: '2026-08-03T09:55:02+00:00',
        metadata: { model: 'gpt-4o' },
        attempts: [
          {
            attempt_id: '74438200973594801',
            attempt_number: 1,
            connection_id: '77114419422695424',
            pool_id: null,
            status: 'succeeded',
            error_code: null,
            latency_ms: 1900,
            cost: '0.01100000',
            provider_request_id: 'req_provider_1',
          },
        ],
      },
      {
        node_key: 'return_1',
        node_type: 'return_response',
        status: 'completed',
        // The flow ended here: there is no edge to have left by.
        output_port: null,
        cost: null,
        duration_ms: 1,
        started_at: '2026-08-03T09:55:02+00:00',
        finished_at: '2026-08-03T09:55:02+00:00',
        metadata: null,
        attempts: [],
      },
    ],
    events: [
      { seq: 1, type: 'accepted', node_key: null, occurred_at: '2026-08-03T09:55:00.012+00:00', payload: null },
      {
        seq: 2,
        type: 'captured',
        node_key: 'model_1',
        occurred_at: '2026-08-03T09:55:02.101+00:00',
        payload: { amount: '0.01100000' },
      },
      { seq: 3, type: 'finished', node_key: null, occurred_at: '2026-08-03T09:55:02.140+00:00', payload: null },
    ],
    ...overrides,
  };
}

/** `GET /v1/executions/{id}/status` — the keys `ExecutionStatusResource` sends, no others. */
export function statusView(overrides: Partial<ExecutionStatusView> = {}): ExecutionStatusView {
  return {
    execution_id: '74438200973594700',
    status: 'completed',
    operation: 'support.answer',
    output: { text: SECRET_PROMPT },
    error_code: null,
    error_message: null,
    cost: { estimated: '0.02700000', actual: '0.01100000' },
    cache: { hit: false, cached_at: null },
    waiting_on: null,
    trace_url: '/v1/executions/74438200973594700',
    ...overrides,
  };
}
